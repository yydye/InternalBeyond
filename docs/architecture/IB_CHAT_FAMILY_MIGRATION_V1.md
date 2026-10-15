# IB Chat Family Migration v1

- 状态：**D4.1-A 冻结；D4.1-B COMPLETE；D4.1-C COMPLETE；D4.1-D 最终验收可开始**
- 日期：2026-10-03
- 本轮生产视觉影响：**#page-chat 的状态、失败恢复、消息动作、群聊说话者活动已采用 IB Visual Language v1 呈现；runtime/state/storage owner 保持原有**
- 适用边界：InternalBeyond Web Chat 主页面与共用 Chat runtime
- 后续阶段：D4.1-D Chat Acceptance & Freeze → D4.2 Personal Space

> Conversation before chrome. Presence must be real. State must mean something. Personal without decoration. Technical never leads. Preserve behavior before changing appearance.

## 1. Purpose

本文记录当前仓库中的 Chat 页面、迷你聊天面板、消息数据、运行时状态、滚动行为、群聊和输入交互，并冻结 Chat 家族如何消费 IB Visual Language。

这是一份 family migration contract，不是生产重写。D4.1-A 没有修改 Chat、CSS、JS、DOM、测试或用户数据；只新增本文件。现有页面的结构与外观只作为审计证据。

本合同适用 IB Visual Language v1 的 Quiet、Spatial、Alive、Personal、Deep，以及：

- Content before chrome
- Space before containers
- State is visual
- Complexity on demand
- Motion means activity
- Personal, not decorative
- Simple at first glance, deep on demand
- Technical never leads

Chat 是连续阅读和实时活动场景。Quiet 不等于稀疏；主要任务是让对话可读、身份清楚、状态真实、输入始终可继续。

## 2. Authority

决策顺序：

1. [IB Visual Language v1](IB_VISUAL_LANGUAGE_V1.md)：产品级视觉和信息深度权威。
2. [IB Visual Token Contract v1](IB_VISUAL_TOKEN_CONTRACT_V1.md)：语义 token 与 Web / Android 映射权威。
3. [IB UI Primitive Contract v1](IB_UI_PRIMITIVE_CONTRACT_V1.md)：共享原语的语义、交互和可访问性权威。
4. 本文：只冻结 Chat domain semantics、当前行为证据和 Chat migration 顺序。
5. 既有 Chat DOM/CSS/JS、测试、截图：现状证据，不覆盖以上规范。

D3 Home 是 production reference：它证明语义 token、透明结构、内容优先层级和 D2 原语可以在真实页面使用。它不是 Chat layout、density、message styling 或 Composer 模板。Chat 可保持双栏、连续消息流、角色身份和固定输入区，不得为了视觉一致复制 Home 的单栏、Section 排布或 Recent 形式。

Family Pattern 表达 Chat 语义。只有已冻结的 D2 原语才是共享 Primitive。D4 不增加 ChatCard、ChatButton、ChatToast 或新的通用状态系统。

## 3. Preflight 与证据范围

### 3.1 Git 工作区快照

| 项 | 审计开始时的值 |
|---|---|
| HEAD | 295fe9ea9261aed8131b806381787c7066668296 |
| Branch | master |
| upstream 差异 | origin/master：ahead 184，behind 0 |
| Staged | 空 |
| 既存 tracked diff | 18 个路径；审计前已存在 |
| 既存 untracked | 15 个文件/目录；审计前已存在 |
| 本轮 claim | 仅新增本合同文档 |
| Commit / push / reset / stash | 未执行 |

审计开始时的 tracked dirty paths：

- InternalBeyond.html
- README.md
- VERSION
- assets/css/core.css
- assets/css/core/widgets.css
- assets/css/home-workspace.css
- assets/css/navigation-shell.css
- assets/js/communication.js
- assets/js/core.js
- assets/js/error-catalog.js
- assets/js/home-workspace.js
- assets/js/navigation-shell.js
- docs/architecture/UI-SURFACE-AUTHORITY.md
- src-tauri/Cargo.lock
- src-tauri/Cargo.toml
- src-tauri/build.rs
- tests/test_home_workspace.js
- tests/test_navigation_shell.js

审计开始时的 untracked paths：

- android/app/src/main/java/com/internalbeyond/mobile/ui/theme/IbSemanticTokens.kt
- assets/css/ui-overlay-primitives.css
- assets/css/ui-primitives.css
- assets/js/ui-overlay-lifecycle.js
- deleted-backup-audit.json
- docs/architecture/IB_UI_PRIMITIVE_CONTRACT_V1.md
- docs/architecture/IB_VISUAL_LANGUAGE_V1.md
- docs/architecture/IB_VISUAL_TOKEN_CONTRACT_V1.md
- docs/release-notes/1.0.7.md
- hibit-identity-transition-report.json
- role-metadata-continuity-report.json
- tests/fixtures/feedback-overlays/
- tests/fixtures/ui-primitives/
- tests/test_ui_overlays.js
- tests/test_ui_primitives.js

本轮保留了全部既存改动。Chat 相关的 dirty runtime 文件是 assets/js/communication.js；审计到的现有 diff 属于 Middle Brain side-effect gating 与计数路径，不属于 message presentation。InternalBeyond.html 的既存 diff 属于 Home/Workspace 内容，没有 Chat markup hunk。assets/js/core.js、assets/css/core.css 和 navigation-shell.css 是 Chat 依赖的共享路由、主题、Toast、Shell 代码，仍作为既存跨页面改动保留。assets/css/core/chat.css、assets/css/core/chat-shell.css、assets/js/social.js、assets/js/chat-core.js、assets/js/chat-authority.js 和 assets/js/group-runtime-core.js 在开始时没有 tracked diff。

### 3.2 只读浏览器证据

使用 InternalBeyond.html 的 file-origin 页面和一个 agent-browser 会话观察了：

- 无 API 角色时的 onboarding / empty Chat。
- 已选择角色但没有历史消息的新会话。
- 有普通消息、Markdown 标题、列表与代码的单聊。
- 长历史：共 68 条，首次窗口渲染 50 条，向上加载后补到 68 条。
- 两名角色发言的群聊。
- Internal 与 Infernal 两个主题。
- 1280、1024、768、390、375、320 CSS px 宽度。

普通 API 配置不存在于该 file-origin 页面。其测试数据使用 d4-fixture 前缀，只用于临时浏览器页面；没有调用 provider、发送消息或写入正常 localhost Web app origin。任务没有启动 HTTP server。浏览器 startup 记录到 127.0.0.1:23115 的 health/context 与 23114 health GET 尝试；检查时这些端口没有 listener，之后 loopback 请求由浏览器 route abort。未发起外网 provider 请求。agent-browser 报告浏览器已关闭，session list 为空；没有终止宿主 Chrome 进程。

Streaming / Thinking 没有真实触发：无凭据，且本轮不为视觉截图接通 provider。它们的创建、更新、持久化和取消边界由源码静态审计。截图不能证明真实网络运行状态。

## 4. Chat Family 边界

### 属于 Chat Family

- 全屏路由 #page-chat、好友/角色/群聊选择、话题列表、主消息流、搜索、只读归档模式和 Composer。
- #chat-panel 迷你浮动 Chat。它与全屏 Chat 共用 activeFriendId、activeThreadId、sendChatMessage、消息 renderer 和流式 runtime，但 DOM 和视觉 host 不同。
- 用户/assistant/system 消息及其 Markdown、图片、文件、语音消息、Thinking disclosure、截断续写、收藏、删除和多选。
- 单聊、话题频道与 group_ 会话的选择和发送边界。
- 真实 typing、thinking、streaming、stopping、IBERR failure 与 delivery lifecycle 在 Chat 中的呈现。

### 属于相邻功能所有权；不会因其出现在 Chat DOM 或 chat.css 中自动纳入 Chat rewrite

- Group member manager、成员添加/静默/移除：social.js 的 group feature；从 Chat 的 Members context entry 打开。
- Voice Call：communication/call.js 与 voice call runtime；Chat header 中的 Start voice call 是入口，不等于 Composer voice message。
- Voice message capture/playback：communication/voice.js、voice-message-core.js；消息 renderer 是 Chat 消费者。
- Calendar 数据与悬浮时钟：calendar.js；Chat sidebar 的 calendar 与全局 #cal-widget 不属于 Chat state。
- Memory、summary、favorites、Middle Brain tool/result、Image Router、Bridge sticker：保留各自 feature/data authority；需要时由 Chat 消费其消息附件或 contextual action。
- Role DM：独立 #page-roledm / role-dm-ui。它与 Chat 共用 chatMessages store 和 IBChatCore schema，但 roledm_ identity、参与方与任务不同，因此不是同一 Chat surface。
- Home Node、API credentials、Activity/Cinema、Economy、Packaging、global App Shell、Android：独立 family / platform ownership。

Mini Chat 仍是 Chat Family 的 legacy host。D4.1-B 只迁移 #page-chat 的主要视觉 surface；因为 send/stream functions 也会触及 #chat-panel，B 必须保留 mini host 的行为并检查共用 renderer，但不能顺带重做它的 layout。

## 5. 当前架构与 Owner

| 层 | 当前 owner | Chat 事实 |
|---|---|---|
| Route / DOM | InternalBeyond.html、core.js navTo | #page-chat 是主要页面；#chat-panel 是浮动迷你 host。导航 entry 使用 Chat route。 |
| Shell CSS | assets/css/core/chat-shell.css、navigation-shell.css | 全屏 max-width 900px；桌面左目录 + 右消息流；窄屏隐藏目录。 |
| Message / Composer CSS | assets/css/core/chat.css | 既有 bubble、speaker、typing、thinking、附件、voice、Composer CSS；同一 stylesheet 还包含 Active Message / Token Dashboard 等邻接样式，不能把整个文件当成 Chat。 |
| Semantic theme | assets/css/core.css | Chat bubble、content、status、space、font、radius、surface roles 在 Internal / Infernal token map 中变化。 |
| Conversation selection | assets/js/social.js | loadFriendsList、selectFriend、selectGroup、selectThread、searchChat；activeFriendId / activeThreadId。 |
| Message rendering and controls | assets/js/communication.js | _buildMsgEl、_renderAllChat、appendChatBubble、_createStreamBubble、loadChatMessages、sendChatMessage、stopStreaming。 |
| Pure message/conversation domain | assets/js/chat-core.js | role 与字段 contract；friendId / threadId 推导 dm/group conversationId；无 DOM、网络或 I/O。 |
| Store / host authority | assets/js/webcore-db-schema.js、core.js、chat-authority.js、home-node-bootstrap.js、home-node-client.js | chatMessages 经 db boundary；host mode 决定 Home Node canonical 与 IndexedDB mirror / local-only fallback。 |
| Group turn planning | assets/js/group-runtime-core.js、communication.js | pure participation planner + communication adapter；成员请求顺序和当前活动 turn 属 runtime，不属 CSS。 |
| Delivery typing | assets/js/delivery-runtime.js、communication.js adapter | queue/delivery lifecycle 维护 typing；DOM adapter 创建/更新/移除 .chat-typing。 |
| Voice message | assets/js/communication/voice.js、voice-message-core.js | capture lifecycle、voice record、playback/transcript。 |
| Error presentation | assets/js/error-catalog.js、assets/js/core.js | IBERR classification and disclosure；legacy Chat callers仍会走全局 toast。 |

## 6. Data 与 State Authority

### 6.1 数据形状和持久边界

IndexedDB schema 为 InternalBeyondDB v24。chatMessages 以 id 为 key，byFriend 索引值是 friendId。chat-core.js 声明的 required message fields 是 id、role、content、friendId、timestamp；条件字段包括 reasoning_content、threadId、senderName、images、files、voice、metadata、truncated、withdrawn、wsSearches、memOps、calNotes 等。

当前没有独立 conversation table。对话 identity 从 friendId 与可选 threadId 派生：

- 普通单聊主对话：friendId。
- 单聊话题：friendId + threadId。
- 群聊主对话：以 group_ 开头的 friendId。
- 群聊话题可在 message schema 表达，但当前群聊 selector/UI 没有暴露 group thread 切换。

apiConfigs 是角色目录与名称/avatar/provider 配置的 owner；groups 是 group 名称和 participant 状态的 owner；chatThreads 是话题频道 metadata 的 owner；chatMessages 是 message history 的 owner。活动、记忆、收藏和 Middle Brain 结果各有自己的 store/authority。视觉迁移不创建第二份当前对话、speaker 或 stream state。

正常 host canonical mode 通过 Home Node authority 决定 chatMessages 写入/同步；IndexedDB 是 materialized mirror。file:// 或关闭 Home Node 的模式走 local-only IndexedDB fallback。这个审计 browser 使用 file://，所以它不能作为 Home Node canonical-mode acceptance。

### 6.2 选择与当前上下文

- activeFriendId 是角色或 group id；activeThreadId 为 null 时读主对话，有值时只显示该话题消息。
- selectFriend 重设 thread 为 null；selectThread 使用 friendId + threadId；selectGroup 使用 group id 并重设 thread 为 null。
- 主 Chat 的 friend list来自 apiConfigs，group list来自 groups。话题子行当前按创建时间排序，不是基于最后消息的 Recent 排序。
- initChatHeader 在存在 API config 时自动选择第一个角色；sendChatMessage 在无 activeFriendId 时也有默认第一个角色 fallback。因此“未选会话”并不是一个稳定、独立的 Chat 状态。
- Composer text 和 pending image/file arrays 是共享 UI runtime state。切换角色/群聊/话题时，现有选择函数不清空 Composer。它不是按 conversation 存储的 drafts。下一轮不能无意间清除，也不能假装它已经按会话隔离。

## 7. Family Inventory Matrix

| Area | Existing implementation | Data owner | State owner | Current visual pattern | Proposed role | Decision |
|---|---|---|---|---|---|---|
| Chat entry / route | #page-chat、导航 Chat link、Home link | 无 | core.js currentPage/hash | Global Shell 中的 route | Shared App Shell + Chat entry | KEEP |
| Mini Chat entry | #chat-panel、openChatPanel | 同 Chat runtime | communication.js + currentPage | 独立 glass floating card | Legacy Chat host / compatibility consumer | LEGACY |
| Role / group selector | social.js loadFriendsList / selectFriend / selectGroup | apiConfigs / groups | activeFriendId | 左侧 friend-item；group item；静态点 | Conversation Navigation，组合 D2 Interactive Row | SEMANTICIZE |
| Thread selector | .thread-item、selectThread | chatThreads + chatMessages.threadId | activeThreadId | friend 下的 nested subrows，按 created 排序 | Conversation Navigation contextual sublevel | SEMANTICIZE |
| Conversation context | .chat-full-header、mini #chat-header-name | apiConfigs / groups | activeFriendId + activeThreadId | full header 显示 search/tool row；full page 没有固定当前身份标题 | Conversation Context Chat Pattern；复用 Page Header 结构能力 | CHAT_PATTERN |
| Search / archive | searchChat、enterChatArchive、selectArch* | chatMessages、archivedConfigs、chatThreads | active query / _chatArchMode | Search input、archive tool strip；archive read-only | Contextual Chat feature, global Form/Status primitives | KEEP |
| Message stream | #chat-full-messages / #chat-messages、_renderAllChat | chatMessages | _ibWin window state | 连续纵向内容；内含 message surfaces | Conversation Stream Chat Pattern | CHAT_PATTERN |
| User / assistant turn | _buildMsgEl / appendChatBubble | chatMessages | active conversation + per-call state | 左/右 bubble；name/avatar/time；system text 独立 | Message Turn Chat Pattern | CHAT_PATTERN |
| Speaker identity / grouping | senderName、metadata.config_id、message group identity | apiConfigs / message metadata | adjacent-turn grouping in renderer | assistant header; user align-right; group names each speaker | Speaker Identity Chat Pattern | CHAT_PATTERN |
| Markdown / operation results | _renderSegments、_renderAiContent、operation-card builders | message fields + feature-owned results | stream filter and final renderer | Inline content, code/table, embedded result cards | Message Content Chat Pattern; feature cards remain owned | KEEP |
| Image / file content | images/files; pickImage/pickFile; _buildFileCard | message fields, uploadedFiles | global _pendingImages / _pendingFiles | preview bar, file card, image viewer | Composer attachment + Message Content Patterns | CONVERGE |
| Voice message | voice payload, _buildVoiceEl, _vmInit | voice-message-core record | Voice capture state | Mic capture button; waveform, transcript and playback | Voice feature consumer inside Chat message patterns | DEFER |
| Composer | #chat-full-input, send/stop/attach/voice controls | no independent draft store; send targets active ids | activeFriendId/thread + module globals | Bottom input row and fixed controls | Composer Chat Pattern + Foundation Controls | CHAT_PATTERN |
| Typing / thinking / streaming | _ibTypingOn, _createStreamBubble, callback nodes | no persistent presence record | delivery runtime / call state / group turn | text timer, optional thinking disclosure, blinking cursor | Conversation Activity Chat Pattern | CHAT_PATTERN |
| Message actions | favorite, delete, select mode, truncated continuation | favorites + chatMessages | _chatSelectMode, individual actions | Star visible; delete hover-revealed; bulk selection bar | Contextual / destructive actions composed from D2 controls | CONVERGE |
| Chat failure | IBERR.report/show, toast fallback, transient assistant error bubble | error catalog + console diagnostics; not message.status | send catch / error presenter | Disclosure when available; otherwise toast + appended text | D2 Error Disclosure / Toast / Inline Status | CONVERGE |
| Group manager | openMemberManager, member picker, member status ops | groups | social.js dialog-local selection | Contextual member dialog and status rows | Feature-specific group management, not Chat primitive | DEFER |
| Voice Call | Start voice call → communication/call.js | voice call session authority | Voice Runtime | Header action and separate call overlay | Voice family feature | DEFER |
| Calendar in Chat | #chat-calendar plus #cal-widget | calEvents/calNotes | calendar.js | Sidebar calendar + independent floating clock | Calendar family, Chat contextual projection only | DEFER |
| Role DM | #page-roledm / role-dm-ui | chatMessages with roledm_ namespace plus Role DM records | independent Role DM runtime | Separate route and speaker task | Separate family, not Chat Core | DEFER |
| Friend dot | friend-item .friend-dot always rendered with fixed accent | none | no runtime presence owner | Static dot beside every row | No presence role; remove if no navigation meaning | REMOVE |

## 8. Frozen Chat Family Patterns

These patterns stay domain-specific. A pattern may compose D2 primitives; reuse alone does not promote it into the global primitive inventory.

| Pattern | Frozen contract |
|---|---|
| Conversation Context | Purpose: answer who/which group is open and expose only necessary actions. Surface: transparent header area, not a settings card. L1: character/group/thread identity and truthful activity. No default provider/model id/endpoint/credential/latency/context-window/runtime/internal id. L2/L3 require explicit entry. Existing owner: #page-chat markup + social selection state. B migration: add persistent current identity to the full Chat header; keep search/actions secondary. |
| Conversation Navigation | Purpose: switch role, group, and thread without losing the meaning of current context. Surface: directory/list; no dashboard cards or status-chip wall. Selected styling cannot mean online. Use Interactive Row semantics and retain create/delete flows. Existing owner: social.js. B migration: keep information architecture; any row semantic repair must preserve current selection and group behavior. |
| Conversation Stream | Purpose: render canonical history and runtime output. Surface: one continuous high-density reading column; do not add a glass panel around each message layer. States: initial load, empty selected context, ordinary history, older-history load, active stream, error. Existing owner: communication.js. Preserve 50-message window and anchor compensation. |
| Message Turn | Purpose: convey speaker, content, temporal relation, and actions. A turn is not necessarily a bubble: role=system is plain centered content; operation results may be embedded. Adjacent same-speaker turns may group, but timestamps and transitions remain understandable. Do not nest card → card → bubble → badge. |
| Speaker Identity | User and assistant differ by alignment, name/avatar identity, and position; color is supplementary. Group speakers use stable config identity when metadata.config_id exists, with senderName as legacy display fallback. Current grouping compares role + identity. Current group replies use assistant role plus per-speaker metadata; do not invent one role per character. |
| Message Content and Meta | Text precedes chrome. Keep content width readable, support long text, code/table overflow within content, images and file interactions, voice transcript/playback and feature-owned operation result cards. Metadata stays secondary. Do not shrink body text to solve overflow. |
| Conversation Activity | Only real request/delivery/voice activity may produce presence. Typing, thinking and streaming are different states. Current idle Chat has no trustworthy online/presence record; the static friend-dot is not presence. State motion must stop when its owner ends. |
| Composer | Purpose: continue the current conversation. Compose with native textarea, buttons and D2 Foundation Controls; do not create a Chat button system. Preserve send, stop, attachment, image, voice, multiline, and shared-draft behavior until separately changed. Composer stays a clear anchor; technical options remain secondary. |
| Conversation Empty State | Distinguish no configured role/setup, selected role with no history, empty group with member context, archived read-only context, and history/runtime failure. Do not use one generic “Nothing here”. Current implementation has setup and new-context text, but no distinct history-unavailable presentation. |
| Message Actions | Primary: send and stop belong to Composer. Contextual: favorite and truncated-response continuation. Destructive: delete one message or bulk-delete selected records. Do not add copy/edit/regenerate/reply because no current message UI owner exists. Keyboard and touch must reveal actions without hover. |

### 8.1 Shared Primitive mapping

| Chat area | D2 composition |
|---|---|
| Conversation header | Page Header capability where useful; chat identity and status remain Chat Pattern semantics. |
| Friend/thread rows | Interactive Row / List Row; current div-onclick markup does not yet satisfy native keyboard contract. |
| Composer | Foundation Controls; Form Group semantics for labelled input/validation if adopted. |
| Attachment menu | Popover lifecycle where the existing action menu is migrated; use native buttons/menu semantics. |
| Member manager | D2 Dialog lifecycle and shared form controls; keep group-specific content. |
| Persistent truthful status | Inline Status; do not add chat-status-green/red or chat-runtime-pill. |
| Send completion | Toast only for short successful confirmation. |
| Failure | IBERR → Error Disclosure with human explanation, recovery, collapsed L3. |
| Calendar, voice call, Role DM, Middle Brain results | Their owning family contracts; no new global primitive from visual similarity. |

## 9. Information Depth and Technical Controls

| Depth | Chat content |
|---|---|
| L1 · Human | Current role/group/thread identity; conversation text; speaker identity; actual typing/thinking/streaming; human-readable failure and recovery; next input action. |
| L2 · Advanced | User-selected reasoning visibility/capability, image/voice mode, group membership/mute policy, thread settings and other explicit contextual controls. This depth is entered by user action. |
| L3 · Technical | Provider, model id, endpoint, credential reference, request id, latency, context window, runtime, trace, raw exception and internal route. Keep in API/Diagnostics/Error Disclosure detail; do not surface by default in the Chat header. |

Current Chat first-screen controls do not expose provider, endpoint, credential, latency or runtime. One conditional leak exists: role display fallbacks use nickname or model, so a missing nickname can put a model string in the visible directory/header. D4.1-B should prefer the user-facing role name when available and must not add technical IDs as replacement identity.

Current reasoning behavior separates content and reasoning_content. Runtime reasoning deltas use onThink; the final message keeps reasoning_content separate and _messageShowThinking controls whether the collapsed thinking detail is rendered. Treat “正在思考” as L1 activity only while a real request is thinking. Reasoning capability belongs in explicit L2. Raw reasoning/trace metadata remains L3; never merge it into ordinary message text.

## 10. Runtime State Matrix

| State | User-facing meaning | Current visual presence | Motion | Persistence | Owner |
|---|---|---|---|---|---|
| sending | User action accepted and request is being prepared | user message is written before provider completion; _chatSendingFor is an internal duplicate-send lock. No distinct sending label is shown. | none specific | user message persists in chatMessages | communication.js sendChatMessage |
| typing | A response unit is being delivered after generation | .chat-typing text, “name 正在输入…”; one runtime node per friend in delivery adapter | currently static text | delivery queue/runtime only | delivery-runtime.js + communication.js _ibTypingOn |
| thinking | A real member/provider request is in progress | Non-stream request uses “name 思考中…” with elapsed seconds. Streaming reasoning detail appears only when showThinking enables it. | timer text updates; no idle loop | transient call/group state; reasoning_content may persist separately | communication.js, group local typing branch, provider callback |
| streaming | Response text is arriving | temporary .chat-msg.ai / .chat-stream-cursor node; stop replaces send while the stream is active | cursorBlink 0.8s while cursor class exists | partial DOM is transient; final aiMsg is stored after completion | communication.js _createStreamBubble + callApiChatStream callbacks |
| stopping | User asked the current generation/delivery to stop | Stop button is visible; no durable “stopped” badge/state | cursor and activity stop during cleanup | call controller/group/delivery state only | communication.js stopStreaming |
| retrying | Internal provider compatibility retry or auto-continuation is underway | No distinct user-visible retry indicator. There is no message-level retry action. A truncated saved response may expose a continue action. | no separate retry animation | retry attempt state transient; final/truncated message persists | communication.js callApiChatStream helpers |
| error | Request failed and the user needs a next step | IBERR disclosure when available; legacy fallback toast plus transient assistant-text notice | no persistent error animation | failure itself is not a canonical message.status field; user message may already have been stored | communication.js catch → IBERR / toast |
| idle | No active request or delivery | no presence indicator; send action available | none | active conversation ids only | social.js + communication.js |
| offline / degraded | Host or provider cannot continue | no stable Chat-header status observed; user may receive an error path | none | host authority status and diagnostics own it | chat-authority.js / IBERR |

A cancel of a non-streaming group member is a current limitation: group runtime marks cancellation and prevents later entries at boundaries, but the active non-streaming provider request is not abortable through that route. This is a runtime contract, not a styling change.

## 11. Streaming DOM Ownership and Scroll Contract

### 11.1 Streaming ownership

1. user/system/assistant message nodes: communication.js _buildMsgEl, appendChatBubble.
2. active assistant stream nodes: communication.js _createStreamBubble, called only while the target friend is active.
3. chunk text and feature-operation cards: sendChatMessage onChunk → stream filter/writers; thinking deltas use onThink → _appendStreamThinking.
4. stream completion: callApiChatStream returns, cursor class is removed, message content/metadata are assembled, then dbPut(chatMessages, aiMsg) persists the final assistant record.
5. stop/cancel: communication.js stopStreaming → delivery abort, GroupTurn cancel, keyed AbortController. _showStreamingUI swaps send/stop controls.
6. errors: sendChatMessage catch removes an empty air bubble; partial streamed text can remain visually, then IBERR handles the error. Failure text appended by appendChatBubble has no persisted message id.

Do not componentize or rewrite this pipeline as part of visual adoption. The visual layer consumes the runtime callbacks and nodes; it does not become the state authority.

### 11.2 Scroll behavior observed from source and test-origin browser

| Event | Current behavior | Migration risk / frozen rule |
|---|---|---|
| Initial history | _renderAllChat shows the latest 50 messages and pins to bottom, then pins again on the next frame. | Preserve the latest-message default. |
| Older history | At scrollTop ≤ 40, _chatWinMore prepends up to 50 messages and compensates by scroll-height delta. Browser audit loaded 18 older records and retained an in-history anchor. | Preserve anchor compensation; do not replace with full rerender. |
| New message append | appendChatBubble unconditionally sets scrollTop to scrollHeight. Group non-stream paths do the same. | A user reading older content can be pulled to bottom. Record this as existing behavior and risk; do not silently change it during B. |
| Stream start | _createStreamBubble appends the active stream node and pins to bottom once. | Preserve start behavior. |
| Each stream delta | Writes update the temporary stream content. No separate per-delta scrollTop assignment was found in the stream callback. | Do not promise per-token bottom pin; browser anchoring during growth is not a frozen guarantee. |
| User scroll upward | History loads above the current view; stick is derived from distance to bottom < 40. | New message append currently ignores stick and may steal position. Any policy change needs a separate acceptance decision. |
| Image load | _chatWinPin registers image load/error handlers; it repins only if the history state still says stick. | Preserve asynchronous image behavior. |
| Conversation switch | selectFriend/selectGroup/selectThread replace the message view, reset context and render the selected history. | Preserve target filtering and initial-bottom behavior; do not mix thread messages. |
| Scroll-to-bottom action | No dedicated Chat scroll-to-bottom button was found. | Do not claim this behavior exists or add a new feature in D4.1-A. |

The stream and delivery state is keyed primarily by friend/group id; thread identity is also passed to delivery cancellation and message filtering. That existing split must be covered in B acceptance, especially switching threads while a request is active.

## 12. Message Content Support Matrix

| Type | Current owner / persisted shape | Current rendering and interaction | Responsive / migration decision |
|---|---|---|---|
| Plain text | chatMessages role/content | user and assistant text; system text is a centered line rather than a bubble | Preserve readable wrapping and system distinction; CHAT_PATTERN |
| Markdown | communication.js _renderSegments / _renderAiContent | headings, paragraphs, emphasis, lists, blockquote, horizontal rule, Markdown links restricted to http/https/mailto, table construction, and fenced code | code uses pre.md-cb with internal horizontal scrolling; retain content-first structure |
| Code | content parser | code blocks with language label and code child | Do not shrink body text; keep code overflow inside its own region |
| Image | message.images and generated image results | alt uses image name or “image”; click opens full-view overlay; lazy decode in history renderer | preserve image sizing, fullscreen close, and scroll anchoring; small screens need rendered check |
| Attachment | message.files; picker may extract text and preserve rich source | file card, metadata, download affordance, preview/remove before send | Keep text extraction/attachment semantics; file parsing stays owned by file feature |
| Voice message | message.voice, voice-message-core | waveform/player, duration, transcript toggle; user capture button in Composer | preserve voice schema and playback; voice runtime redesign deferred |
| System/event | role=system | plain centered inline text | Do not style as ordinary user/assistant turn |
| Tool / feature result | wsSearches, memOps, calNotes, workspace/image operation card payloads | contextual cards or notices inside/adjacent to message content; originating feature owns action and data | Preserve feature ownership and result ordering; do not flatten to generic Chat badge |
| Reasoning detail | reasoning_content / legacy thinking | separate collapsible disclosure when configured | L2 entry; raw reasoning/trace remains explicit and collapsed |
| Timestamp | message.timestamp | visible in full Chat speaker header / continuation metadata; compact metadata | retain temporal relation without shrinking below readable metadata |

Long paragraphs use pre-wrap and word-wrap. Markdown code blocks scroll inside their own region. Browser audit exercised moderate long-history density and code rendering; it did not validate huge binary images, pathological URL lengths, or every spreadsheet/document parser.

## 13. Composer Contract

| Capability | Current behavior to preserve |
|---|---|
| Input authority | Full page uses #chat-full-input; mini host uses #chat-input. sendChatMessage selects by currentPage and captures activeFriendId / activeThreadId at invocation. |
| Empty input | No send when text, voice, pending images and pending files are all empty. |
| Send | User record is written before provider request. On completion, assistant record is stored with the captured target. |
| Multiline | chatKeyDown sends on Enter when Shift is not held; Shift+Enter inserts a newline. autoResizeInput caps current height at 100px. |
| Stop | A visible stop button replaces the send button during streaming. No keyboard stop shortcut exists in chatKeyDown. |
| Attachments | Attach popup provides image and file actions. Image picker allows multiple images and compresses to at most 2048px before sending. File picker supports text/rich document formats and extraction. |
| Image | Images travel as message image records and display in message content; actual provider image handling stays in communication runtime / provider capability. No separate Chat image-route control was found in the full Composer. |
| Voice | chat-voice-full / chat-voice-mini use a native button click to toggle capture and send; call initiation is a different feature. |
| Sticker | An injected ib-sticker-btn is labeled “表情（需 Bridge 已启动）”; keep as Bridge feature, not a new Chat control primitive. |
| Disabled/loading | During streaming the stop control appears; no general non-stream “sending” label was found. CSS has :disabled rules, but do not infer that every validation/request state is surfaced through them. |
| Draft | Text and pending attachments survive current friend/thread/group selection because selectors do not clear shared Composer state. Drafts are not per-conversation persisted state. Preserve this exact scope unless a separately accepted behavior change moves to conversation-keyed drafts. |
| Archive | Read-only archive hides the input and shows an archived notice. |

The current composer has no associated visible label; the placeholder is the accessible name exposed in the browser tree. B may add a persistent accessible label without changing the placeholder or send key behavior.

## 14. Keyboard and Message Actions

### 14.1 Keyboard contract

| Input | Current behavior |
|---|---|
| Enter | Sends when Shift is not held. |
| Shift+Enter | Keeps multiline input. |
| Ctrl/Cmd+Enter | No special handler found. |
| Escape | chatKeyDown does not handle it. Attachment popup has pointer-outside close; no Chat Escape handler was found. |
| Tab | Native focus sequence for native controls; no Chat-specific roving focus model. |
| Attachment keyboard | Trigger is a button, but popup options are divs with onclick handlers; keyboard semantics are not equivalent to native buttons. |
| Stop shortcut | None found. |
| Voice button | Native button click toggles recording; preserve its keyboard activation and touch press/click behavior. |

### 14.2 Action hierarchy

- Primary: send / stop / attachment entry live in Composer.
- Contextual: favorite toggle; continue a saved truncated response; contextual provider/feature actions remain feature-owned.
- Destructive: delete one message; select mode plus selected-message delete/cleanup.
- Not implemented in current message UI: copy, edit, reply, regenerate, manual retry. Do not add these during migration to fill visual space.
- .chat-msg-del is a 16px control hidden at opacity 0 until message hover; its CSS has no matching focus-within reveal. It is not discoverable enough for keyboard/touch. Favorite is visible, but its hit target and accessible context still require review.
- Directory rows and attachment menu items are clickable divs without native button/link semantics. This is a keyboard/accessibility debt, not justification for a new component system.

## 15. Errors, Recovery and Status

| Situation | Current presentation | D2 / D1 destination |
|---|---|---|
| Provider/send failure | IBERR.report with humanized message; Error Disclosure if a model is returned; legacy toast fallback; active view may append a transient assistant-style error line. | IBERR → Error Disclosure; human explanation + recovery; collapsed L3. |
| Attachment/image validation or read failure | Several current callers call toast with size/type/read text. | Composer/Form validation for input error; operation failure uses Error Disclosure. Existing Toast callers remain migration debt. |
| Persistent host/provider degradation | No stable current status row in the full Chat header was observed. | Inline Status only for a persistent truthful condition. |
| Short success | Legacy toast callers exist for favorite, deletion, send/other operations. | Toast is a brief confirmation, not a failure endpoint. |
| Technical detail | Console / IBERR detail and runtime logs. | L3 explicit entry, never default header content. |

Chat must not introduce chat-status-green, chat-status-red, chat-runtime-pill, or another error model. Current friend-dot is constant UI decoration, not proof of online state. Do not relabel it as presence.

## 16. Group / Multi-role Contract

Current facts:

- group records contain group id/name and members with characterId plus active, muted or removed status. Membership changes are owned by social.js / groups store.
- A user turn is stored once. Group targeting is recorded in message metadata as targetSpeakerIds. group-runtime-core resolves participation and planned speaker entries; communication.js owns provider calls, typing/stream nodes and final message persistence.
- Group replies remain role=assistant. Identity is represented by metadata/config id and sender name; the renderer uses stable config id when available and senderName as compatibility fallback.
- Member turns are scheduled sequentially by the current group loop. During an actual turn the runtime knows the member config; no durable “active speaker” fact is written for idle time.
- Group typing/thinking is per current member request. Group-wide status and participant status are not the same state. Do not show a group-wide indicator as if every participant is active.
- Group creation supports ordered members and mention-only/muted behavior. Member manager actions belong to a contextual member surface, not a persistent row of controls in the main conversation.
- The observed group stream used the same user-right / assistant-left alignment and visible Lian/Mira speaker names. The name/turn sequence distinguished speakers without an avatar color palette. Browser fixture was synthetic; the behavior boundary above is from current code.

Freeze: stable speaker identity before visual color; one speaker transition per actual turn; no avatar rainbow, pill wall, false presence, or group-wide “thinking” inferred from a currently selected memory member dropdown.

## 17. Empty Chat States

| Case | Current evidence | Contract |
|---|---|---|
| No configured role/API | Empty setup block says there are no chat-capable roles and offers “开始设置”. | Setup/onboarding state, distinct from conversation empty. |
| Selected role, no messages | selectFriend renders “与 {name} 的对话” as a system row. | New conversation with identity and a helpful next action. |
| Empty group | selectGroup renders group name plus member names/status text. | Group context, not generic empty. |
| No active selection | initChatHeader selects first config when present; no stable dedicated no-selection page state was found. | Keep explicit no-selection only if navigation design needs it; do not claim it exists today. |
| Archived | Read-only archive context replaces input and shows archive notice. | Read-only/archive state, separate from empty. |
| History unavailable | loadChatMessages catch renders the same “发送消息开始对话” text as empty history; full select paths do not expose a distinct history-error state. | Current conflation is debt; future error must identify failure and recovery. |
| Character/group unavailable | Missing group currently produces a toast; missing character has no explicit stable Chat empty state found. | Do not reuse generic empty for unavailable/degraded identity. |

## 18. Responsive Audit

Viewport tests used 800px desktop height, 844px at 390, 812px at 375, and 780px at 320.

| Width | Page horizontal overflow | Sidebar | Composer input measured | Observed risk |
|---|---|---|---:|---|
| 1280 | none | visible | desktop width | Full directory + stream; floating Room tab on right edge. |
| 1024 | none | visible, 190px | 480px | Main column remains usable. |
| 768 | none | visible, 190px | 300px | Just above the 760px hide breakpoint. |
| 390 | none | hidden | 84px | No replacement role/thread/group selector in the full Chat surface. |
| 375 | none | hidden | 71px | Same missing selector; composer controls consume most width. |
| 320 | document/body 320px; Composer content 232px in 230px client | hidden | 34px | Text entry is severely constrained; no selector; internal two-pixel composer overflow. |

CSS hides .chat-sidebar at max-width 760px. No alternate selector entry was found in the mobile full page. The global shell uses a narrow navigation rail. When the global Calendar floating #cal-widget is open, its CSS width remains 316px; at 320px with right:14px it begins at x=-10 and overlays Chat content. Calendar owns that surface. It must be separately checked rather than embedded into Chat ownership. The desktop screenshot showed the Room tab outside the Chat column; its narrow interaction belongs to Shell/Mobile acceptance.

Chat messages use 76% max width on desktop and 92% at max-width 760px. No document-level horizontal overflow appeared at sampled widths, but that does not make the 34px input functional. This is a D4.1-B/C responsive acceptance item, not an A-phase fix.

## 19. Accessibility Audit

| Check | Status | Evidence / debt |
|---|---|---|
| Heading hierarchy | PARTIAL | Main route has list headings; no stable visible h1/current conversation heading in ordinary full Chat. |
| Message semantics | PARTIAL | Message stream is div-based and has no role=log / aria-live announcement contract. |
| Speaker labels | ALIGNED / PARTIAL | Names are visible; avatar is supplementary. System row has distinct styling. Group identity fallback can use senderName. |
| Button names | PARTIAL | Send has aria-label; several controls rely on title; injected sticker button uses title and glyph. |
| Composer label | PARTIAL | Placeholder is exposed, but no associated persistent label/aria-label on textarea. |
| Focus order | PARTIAL | Native controls follow DOM order; directory and popup action divs are not keyboard controls. |
| Live status | VIOLATION | No Chat live region for stream/typing/thinking status was found; do not announce every token. Announce real state transitions only. |
| Typing / thinking | VIOLATION / PARTIAL | Visual state has no live announcement. Thinking disclosure is an explicit button pattern, but its runtime content is still sensitive detail. |
| Message actions | VIOLATION | Delete is 16px and hover-revealed without focus-within visibility; action discovery is weak on keyboard/touch. |
| Images | ALIGNED / PARTIAL | Message images use name or “image” alt; decorative avatars use empty alt beside visible name. Fallback alt quality depends on source filename. |
| Keyboard | PARTIAL / VIOLATION | Enter/Shift+Enter are known; selector and attachment popup divs lack native activation semantics; no Escape/stop shortcut. |
| Touch target | VIOLATION | Send/attach/voice controls are 38px; injected sticker is 28px; delete is 16px, below the D2 44px touch contract. |
| Reduced motion | ALIGNED | core.css global prefers-reduced-motion rule reduces animation/transition duration and disables smooth scrolling. |

No Chat-specific axe run was performed. D2 fixture axe results do not establish Chat accessibility.

## 20. Motion Audit

| Motion | Class | Owner / rule |
|---|---|---|
| Message/header fadeUp, 0.25–0.3s | STRUCTURAL | Message entry only; do not turn into persistent ambient motion. |
| Thinking disclosure expansion, 0.25s | STRUCTURAL | Only on explicit disclosure. |
| Streaming cursor blink, 0.8s infinite | STATEFUL | Valid only while stream cursor exists; current completion removes class. |
| Voice capture vmPulse / vmDot | STATEFUL | Only while recording; stop/cancel must end it. |
| Voice playback vmArc | STATEFUL | Only while playback is active. |
| Control hover/focus transitions, commonly 0.2–0.3s | STRUCTURAL | Existing raw duration values are legacy module debt; new code uses token durations. |
| Active Message stage ring / slide effects in same chat.css file | FEATURE-OWNED / DEFER | Not Chat stream presence; do not migrate because of stylesheet co-location. |

No permanent breathing dot, random mood, ambient avatar motion or fake online state is an allowed Chat pattern.

## 21. Theme Contract

Browser observation confirmed the same #page-chat DOM, selected role, 68 message records and column hierarchy in Internal and Infernal. body.theme-infernal changes semantic colors; it does not change conversation information architecture or speaker alignment.

Migration rule: same roles, states, interactions, grouping and responsive layout in both themes. Themes change emotional color values through semantic tokens. Raw rgba, glass aliases and literal radii are current debt to map during family migration, not permission for two theme-specific Chat layouts.

## 22. CSS Debt Map

| Classification | Current evidence | Handling |
|---|---|---|
| SEMANTIC TOKEN CONSUMER | chat bubble roles, content/status colors, spacing, typography, focus, input and surface vars are consumed in chat-shell.css / chat.css. | Keep role meaning; replace old aliases only where D1 mapping names the equivalent. |
| LEGACY COMPATIBILITY | #chat-panel uses glass-card; attachment popup and ambient controls use glass vars/backdrop/shadow. | Keep existing consumer during B; do not add new default glass layers. |
| MODULE PRIVATE | .chat-msg, .chat-msg-header, .chat-thinking-wrap, .chat-file-card, .chat-typing and group/thread row selectors. | Remain family/feature CSS, not shared primitive taxonomy. |
| RAW VALUE DEBT | Bubble radius 14px; small fixed gaps; control sizes 38/28px; 0.3s transitions; raw rgba image-preview/fullscreen overlays; metadata inherits fs-meta at 0.74rem. | Map to semantic tokens and target sizes in B/C; no bulk rewrite in A. |
| STRUCTURAL DEBT | Full vs mini host have divergent headers/render modes; identity not pinned in full header; directories hidden on mobile; click divs and hover-only delete; continuous feature controls share top row; one CSS bundle contains unrelated Active Message/API surfaces. | Restrict future selectors to owned Chat DOM and migrate by boundary, not file sweep. |

The message bubble is an actual speaker/content surface, not a universal card template. Preserve only surfaces that encode speaker, message, media or interaction. Do not add a message card inside a stream panel inside a glass page card.

## 23. Existing Functionality Preservation Matrix

| Capability | Current owner | Must preserve | Migration risk |
|---|---|---|---|
| Send | communication.js sendChatMessage | Empty guard, target capture, one user write before request, correct friendId/threadId/group routing. | High: target race, accidental duplicate send, dropped attachments. |
| Stream | _createStreamBubble + callApiChatStream callbacks | One transient node receives chunk text; reasoning remains separate; final message persisted once after processing. | Very high: streaming DOM and final row can duplicate or lose content. |
| Stop | stopStreaming / AbortController / Delivery Runtime / GroupTurn | Abort active request/delivery and cancel later group entries; preserve known non-stream group limitation. | Very high: wrong target or uncontrolled group participant. |
| Retry | provider call helpers | No manual message retry exists; preserve automatic protocol/token retry and truncated continuation behavior. | Medium: UI might invent a second request path. |
| Thread switch | social.js selectThread | Filter messages by friendId + threadId; reset on selectFriend/group; keep target identity. | High: cross-thread history mixing. |
| Group chat | social.js + group-runtime-core + communication.js | Member order/policy, one user record, planner identity, per-member replies, cancellation boundaries. | Very high. |
| Attachments | pickImage/pickFile, _pendingImages/_pendingFiles | Preview, validation, extraction, same sent message association. | High: draft leakage or silent attachment loss. |
| Images | image record + _viewImageFull | Preview/fullscreen, alt, provider capability path, image load scroll pin. | High. |
| Voice entry | communication/voice.js | Native click activation, capture/send lifecycle, voice schema and processing. | High; implementation remains Voice-owned. |
| Message actions | favorite/delete/select mode | Favorite identity, delete semantics, bulk selection and confirmation behavior. | Medium/high because controls are hover-dependent. |
| Typing | delivery-runtime.js + adapter | Only on active delivery; remove/reassert on switch as current. | Medium. |
| Thinking | provider onThink + _buildChatThinkingEl | Separate from content; config-gated; no default full chain. | High privacy and live-state risk. |
| Scroll | _renderAllChat / _chatWinPin / _chatWinMore / appendChatBubble | Initial bottom, windowed history, anchor compensation, image handling and current auto-bottom behavior. | Very high. |
| Draft preservation | shared textarea and pending arrays | Current selection preserves shared unsaved input/attachments; no per-thread draft storage. | High cross-conversation leakage risk if future ownership changes silently. |
| Member behavior | groups store / social.js manager | active/muted/removed status, add/remove, mention-only rules and group order. | High if group rows are restructured without feature owner. |

Before any B code change, these behaviors require targeted tests or equivalent deterministic browser fixtures. Current test names are listed in §25; this audit did not execute them.

## 24. Production Migration Order

### D4.1-B · Chat Core Production Adoption

Limit the first production adoption to #page-chat:

1. Conversation Context / Header with persistent selected role/group/thread identity.
2. Conversation Stream with current bounded history and scroll behavior preserved.
3. Message Turn and Speaker Identity with readable grouping and color-independent identity.
4. Composer and basic distinct empty states.
5. D2 Interactive Row / Foundation Controls / Page Header / shared error primitives only where semantically applicable.

Keep the existing navigation information architecture and group manager as contextual feature. Keep #chat-panel as a legacy consumer and scope new CSS so it remains functional. Do not redesign Group manager, Voice Call, advanced settings, global Toast callers, all dialogs or technical controls. Do not rewrite provider, streaming, Home Node, group planning, storage or delivery runtime for visual consistency.

### D4.1-C · Chat States / Feedback / Multi-role

Own typing/thinking/streaming visuals; stop/cancel state; error/recovery; group speaker/participant state; message actions; explicit advanced contextual controls; live announcements and touch/keyboard discovery. Keep state owner in runtime modules and present its truth.

### D4.1-D · Acceptance & Freeze

Validate both themes, all widths from 1280 through 320, long history, older-history anchoring, incoming message while scrolled up, live stream completion/cancel, errors, group turns and composer keyboard/touch behavior. Freeze only after behavior delta is deliberate and documented.

### Deferred outside D4.1

Personal Space redesign, System/Middle Brain, Memory family, Voice Call family, Economy/Packaging, global Shell/Mobile, Android primitives and Role DM. Chat may preserve their existing message/result integration without adopting their whole UI.

## 25. Automated Baseline

### Discovered Chat/message tests

- tests/test_chat_core_contract.js
- tests/test_chat_authority.js
- tests/test_chat_migration.js
- tests/test_chat_smoke.js
- tests/test_chat_smoke_provider_contract.js
- tests/test_chat_context_lazy_injection.js
- tests/test_m1a_chat_authority_smoke.js
- tests/test_message_sequence_contract.js

### Discovered group tests

- tests/test_group_participation_planner.js
- tests/test_group_explicit_targeting.js
- tests/test_group_turn_identity.js
- tests/test_group_turn_cancellation.js
- tests/test_group_speaker_identity.js
- tests/test_group_dynamic_runtime.js
- tests/test_group_targeting_history.js
- tests/test_group_recent_speakers.js
- tests/test_group_runtime_trace_binding.js
- tests/test_group_participation_integration.js
- tests/test_group_participation_policy.js
- tests/test_group_participation_policy_integration.js
- tests/test_group_participation_policy_storage.js
- tests/test_group_participation_policy_ui.js

No dedicated tests/test_communication*.js file was found; communication paths are exercised by Chat/group harnesses. Repository structure checks are tests/test_frontend_structure.js and scripts/ui-guardrail.js check.

This was a documentation-only audit, so Chat, group, frontend structure and UI guardrail suites were not run. The latest D3 closeout evidence already present in the work session was: UI primitives 38 pass; overlays 39 pass; error catalog 124 pass; Home/navigation pass; frontend structure retained its two known baseline failures; UI guardrail retained the known BOM failure; git diff --check passed. Those are prior D3 results, not a fresh D4 Chat run. D4 final diff check is recorded in the completion report.

## 26. D4.1-A Closure and D4.1-B Handoff

Closure criteria are satisfied:

- Chat family boundaries and adjacent feature boundaries are documented.
- DOM, CSS, JS, message storage, host authority, stream, stop, typing, group-turn and error owners are named.
- Message types, keyboard behavior, composer/draft scope, group behavior, L1/L2/L3 and D2 mappings are recorded.
- Initial scroll, older-history anchoring, stream-node lifetime, image pinning, conversation switching and current force-bottom behavior are documented.
- Browser audit covered empty/new, normal, long, group, theme and all requested viewport widths using a test-origin fixture. Streaming was not triggered because no provider credential was present and the browser requests were blocked.
- No production visual or runtime file was modified.

**Phase decision: D4.1-A COMPLETE — CHAT CORE MIGRATION MAY PROCEED**

D4.1-B can begin from this contract. It must keep the Chat runtime and data authorities intact, scope adoption to the full Chat host, preserve mini-panel consumers, and add focused regression coverage before changing the stream or Composer DOM.

## 27. D4.1-B Production Adoption Closure

### 27.1 生产落地边界

D4.1-B 只迁移全屏 `#page-chat` 的主要对话 surface。`#chat-panel` 保持 legacy host；共享消息 renderer 的 DOM 改动仅用于稳定 full Chat 的 speaker identity/grouping，mini host 原有布局和行为保持可用。没有触碰 Role DM、Voice Call、Calendar、Memory、Middle Brain、global Shell 或 Android 的产品实现。

新增 `assets/css/chat-family.css` 并在主文档加载。该文件限制在 `#page-chat`，消费冻结的 `--ib-token-*`；没有新增 token、按钮/卡片/state family、glass layer 或技术信息展示。`Message Turn` 是 Chat family pattern，不是共享 Primitive。

### 27.2 生产 DOM 与选择权威

| Surface | 生产采用 | Runtime / state authority |
|---|---|---|
| Conversation Context | D2 Page Header identity；当前角色、群组或话题名称；次级工具仍在既有工具行 | `social.js` 的 activeFriendId / activeThreadId 与既有选择函数 |
| Narrow Selection | 760px 以下显示带 label 的 native select；选项是角色、群组、话题和归档对话的投影 | `handleChatConversationSelect` 委托 `selectFriend` / `selectGroup` / `selectThread` / 归档选择函数；没有第二份会话状态 |
| Conversation Stream | 透明阅读面；保留有界 history、消息排序与现有容器 | `communication.js` `_renderAllChat`、`_chatWinMore`、`_chatWinPin` |
| Message Turn | 角色对齐、speaker identity、同一 speaker 连续 turn 收敛；system row 独立且 subdued | `_buildMsgEl` / `_chatWinMsgEl` / `appendChatBubble`；只增 presentation attrs/grouping，不写新消息字段 |
| Composer | D2 Foundation Controls 与 Form Group；既有图片、文件、贴纸、语音、发送、停止入口 | 现有 textarea、pending attachment state、`chatKeyDown`、`sendChatMessage`、`stopStreaming` |
| Empty / unavailable | 未选择、新会话无消息、历史不可读分别表达；历史失败可重试，技术详情需显式展开 | 既有选择函数、`dbGetByIndex` 与 IBERR/Error Disclosure |

Header 默认不显示 provider、model、endpoint、credential、latency、request id 或 runtime，也不伪造在线/活动状态。群聊沿用现有 speaker identity 与 turn 顺序，不增添 current-speaker state。

### 27.3 保持不变的运行时行为

| Contract | D4.1-B 结果 |
|---|---|
| Selection | 沿用 `activeFriendId` / `activeThreadId` 和现有选择函数；conversation switch 显示对应 stream |
| Storage | 沿用 `chatMessages` 与现有 DB/Home Node authority；selector 仅投影数据 |
| Stream lifecycle | `_createStreamBubble`、token append、finalization、cancel 与 provider continuation 的 owner/顺序未替换 |
| Persistence | transient stream node 仍不落库；最终 assistant message 仍只写入一次 |
| History | 首次显示最新 50 条；向上加载旧记录保持 anchor；message order 不变 |
| Append scroll | 沿用现行 append-to-bottom policy，没有改成条件性 auto-scroll |
| Composer keys | Enter 发送；Shift+Enter 不拦截浏览器换行；停止入口仍使用原 cancel owner |
| Group | planner、成员顺序、speaker identity 与取消边界未改变；已有 group messages 可正常呈现 |

`communication.js` 的 D4.1-B hunks仅为 `_chatSpeakerKey`、sender data attributes 与重复 speaker heading/time continuation 的 DOM 呈现。该文件内 Middle Brain side-effect gating/counting hunks是原有 dirty work，未覆盖或改写；存储、请求和 stream owner 仍未改变。

### 27.4 Responsive 与浏览器证据

| Viewport | document scroll width | Composer input width | Send / Attach / Voice / Sticker | Sidebar / selector |
|---:|---:|---:|---|---|
| 1280 | 页面无横向溢出 | desktop layout | 44px target controls | sidebar visible |
| 768 | 764px | 204px | each 44×44px | sidebar visible；selector hidden |
| 390 | 386px | 212px | each 44×44px | sidebar hidden；selector visible |
| 375 | 371px | 197px | each 44×44px | sidebar hidden；selector visible |
| 320 | 316px | 142px | each 44×44px | sidebar hidden；selector visible |

320/375px 下 Composer 第一行固定留给可输入区域与 Send/Stop，Attach、Sticker、Voice 在次行；没有删去入口。Native selector 在窄屏用键盘 ArrowDown/Enter 切换到既有对话。浏览器 fixture 使用临时 synthetic records、隔离 profile 与本地 mock API，不调用 provider；D4 fixture 按 friendId 清理，test-owned profile 在 teardown 删除。

同一 DOM / IA / controls 在 Internal 与 Infernal 下复用。axe-core 4.10.3 对 `#page-chat` 在 1280 Internal 和 390 Infernal 各扫描 20 条规则，均为 0 violations。Composer Enter/Shift+Enter、selector 键盘切换、focus、group render、long text/code/table/image/file、50 条 history、anchor、append scroll、stream completion/cancel 均由 `tests/test_chat_smoke.js` 覆盖。

截图 evidence 由 smoke harness 保存到 OS temp；最后一次完整通过目录在运行日志的 `D4.1-B browser evidence` 行。Calendar clock overlay 与 narrow global Shell overlay 在截图中仍可覆盖部分页面；它们是 D4.1-A 已知相邻债务。本阶段没有改它们的代码、z-index 或 stacking context，新增 Chat CSS 未引入 overlay 或 z-index。

### 27.5 回归结果与剩余债务

- `test_chat_smoke.js`：通过，包含 D4.1-B browser gates；mock/provider 请求限于 localhost test server。
- `test_chat_authority.js` 59、`test_chat_migration.js` 58、provider wire-format、lazy injection、message sequence 166、group participation planner 109、group speaker identity 50：通过。
- navigation shell、Home workspace、UI primitives 38、UI overlays 39：通过。
- `test_chat_core_contract.js`：90 pass / 1 existing failure，DB version `24` 与 test expectation 不一致；D4.1-B 没改 DB schema。
- `test_frontend_structure.js`：保留原有 2 failures（`memory-authority.js` BOM、Image Router credential-origin wording）；D4.1-B stylesheet count 已明确更新为 25，新增 Chat CSS 有 UTF-8 BOM。
- `ui-guardrail.js check`：仍报告原有 `memory-authority.js` BOM failure；D4.1-B CSS debt delta 为 0。最终 CSS totals：gradient 214、backdropFilter 109、bgRgba 31、bgHex 11、smallFont 12、bigRadius 18、important 59、rawHex 127、violet 0。新增 Chat stylesheet 未引入 raw color、arbitrary radius/shadow/motion、glass 或 literal z-index。
- `git diff --check`：D4.1-B closeout 必须通过；staged 仍为空，不自动 commit / push。

继续 deferred：mini Chat legacy glass、Calendar overlay、global Shell mobile navigation 与 D4.1-C 的 typing/thinking/stream presentation、provider error/recovery、message actions、multi-role presentation、advanced contextual controls。D4.1-B 不再扩展到这些阶段。

**Phase decision: D4.1-B COMPLETE — CHAT STATE MIGRATION MAY PROCEED**

## 28. D4.1-C Pre-implementation Owner Map

本表在 C 阶段生产 UI 修改前，根据当前源码核对。它冻结的是信号来源与生命周期；视觉 adapter 只能读取这些事实，不持有平行状态。

| State | Current owner | Source signal | Lifetime | Persistence | Current presentation |
|---|---|---|---|---|---|
| sending | `communication.js` `sendChatMessage` | `_chatSendingFor` keyed by friend/group; request body/attachments accepted; current code attempts to disable `#chat-send-btn` | after input validation/preflight through shared send cleanup; lock removed on group exit or final send cleanup | user message is written before provider completion; no `message.status` | user turn appears; legacy send button disable may target mini id while full host uses `chat-send-full`; no separate L1 sending text |
| typing | `delivery-runtime.js` queue → `communication.js` `onTyping` / `_ibTypingOn` adapter | runtime state `delivering` + `typingOn`; callback transitions from bounded delay/typing timer; group sequential outputs use the current member's loop identity | one unit's bounded `typingDuration` (≤ 6s), cleared before `onUnit`, on cancel/fail/finish, or conversation switch/re-render | queue/typing are memory-only; delivered units alone enter `chatMessages` | `chat-typing` “name 正在输入…”; currently no explicit live-region semantics |
| thinking | `sendChatMessage` / group member request owner in `communication.js`; raw reasoning source remains provider `onThink` | non-stream call start drives `_ibTypingOn(...,'thinking')` or group-local timer; streaming raw details arrive only through `onThink` and are config-gated by `showThinking` | request phase until normal/error/cancel cleanup; provider reasoning text may be stored separately on final message | transient timer/call state; optional `reasoning_content` persists separately from reply text | “name 思考中…” timer for non-stream; optional expanded raw thinking panel for streaming; no distinct L1 stream pre-token status |
| streaming | `communication.js` `callApiChatStream` callbacks + `_createStreamBubble` | `onChunk` writes text to a transient node; first token is the reliable content-stream signal | transient stream node from request setup through finalize/cancel/error; no state survives on idle | final assistant record is persisted once; transient node is not a second record | `chat-stream-cursor` is currently added at stream-node creation, before first content token; full Chat CSS blinks it until cleanup |
| stopping | `communication.js` `stopStreaming` + `_chatCallStates[target].stopped/abortReason`, delivery abort and GroupTurn cancellation | actual Stop activation sets `user_stop` and aborts the current controller / pending delivery; non-streaming group provider limitation remains | from Stop request until the current async path catches/cleans up; no durable stopped state | runtime-only; already delivered/persisted messages remain | Stop replaces Send while stream is active; no separate persistent “stopped” badge |
| retrying | `communication.js` provider protocol/output-limit helper loops | local compatibility retry/parameter fallback and bounded auto-continuation rounds | inside one provider invocation/turn; no message action state | attempts transient; only final/truncated response persists | no user-visible provider retry; persisted truncation uses `workspace.js` `_buildContinuePill` / `continueTruncatedMsg` (“继续生成”), not generic Retry |
| error | `IBERR` model in `error-catalog.js`; `sendChatMessage`/group catches in `communication.js`; history read boundary in `social.js` | caught error + stage/config context; `IBERR.report`/`present` classifies; DB read errors stay at conversation boundary | per request/read/action failure; duplicate suppression is owned by IBERR | no canonical `message.status`; user turn may already persist; partial stream text may remain | IBERR Error Disclosure when available; current fallback uses failure Toast and a transient assistant-styled line; history failure already has a Chat-level disclosure |
| idle | derived by absence of `_chatSendingFor`, `_chatCallStates[target]`, stream node, delivery `stateOf(conversationId) !== 'idle'`, and GroupTurn registration | existing runtime APIs/DOM only; no idle event or presence source | no active call/delivery/stream | no persistence | no trustworthy online/active-speaker indicator; must remain absent |

### 28.1 Real Message Action Inventory

| Action | Current owner / semantics | Classification | C decision |
|---|---|---|---|
| Favorite / unfavorite | `_msgFavBtn` → `_toggleMsgFav` → `IB.favorites` | CONTEXTUAL, reversible | keep existing action; synchronize accessible name/state; retain success Toast only |
| Delete one message | `.chat-msg-del` → `deleteSingleMsg` → `dbDelete('chatMessages', id)` | DESTRUCTIVE | preserve immediate-delete semantics; make touch/keyboard discovery real; no new confirmation |
| Select / bulk delete | `toggleChatSelectMode`, `_toggleMsgSel`, `deleteSelectedMessages` | CONTEXTUAL + DESTRUCTIVE | retain existing flow; make selection controls native/keyboard/touch accessible |
| Continue truncated reply | `continueTruncatedMsg`; calls the existing continuation path with prior assistant text | CONTEXTUAL / execution | retain “继续生成” meaning and owner; do not relabel as Retry |
| Copy / Edit / Reply / Regenerate / manual Retry | no production message action owner/handler found in current Chat UI | N/A | do not add |

The only speaker activity evidence for group execution is the current sequential loop member/config and its message metadata/stream node. `_ibGroupTurnStates` reports group-turn lifecycle (`created/planning/planned/executing/cancelled/completed`) and counts; it does not publish a trustworthy idle active speaker. C must not derive “online/ready/active” from planner entries, participant status, or memory-member selection.

## 29. D4.1-C Baseline Recheck

Before any C implementation change, `test_chat_core_contract.js` reran with **90 pass / 1** unchanged `DB_VER=24` expectation mismatch; `test_delivery_runtime.js` passed **160** checks. The D4.1-B browser/authority/selection/history evidence above is preserved as the C entry baseline; fresh C browser evidence and regression deltas will be added in the C closure section.

## 30. C2 Pre-implementation Failure / Toast Inventory

本清单只覆盖 Chat consumer 本轮会迁移的调用；成功确认保持 Toast，Feature-owned Image Router long-task feedback单独标记，不重做其 runtime。

| Current caller / path | Current copy/presentation | Classification | C2 action |
|---|---|---|---|
| `sendChatMessage` single/group catch | `IBERR.report` + `IBERR.show` when available; fallback failure Toast; then transient assistant-looking error text | provider/send operation failure | Keep IBERR model and collapsed L3; render its L1 summary at the failed conversation turn; remove fake assistant row and Toast-only fallback |
| Group missing/invalid member config | Toast then early return after user turn may already be stored | group request validation | Conversation-scoped human explanation and settings recovery; no planner/order change |
| `_ibGroupParticipationFailClosed` | console diagnostic plus Toast; planner-empty branch may also append a system row | local planning/degraded state | Keep stable diagnostic code; use one readable stream status; remove duplicate Toast |
| `pickImage` / drag image | unsupported type, oversized file, count cap, compression/read failure Toast | Composer validation / operation failure | Full and mini Composer feedback; no failed attachment is added |
| `pickFile` | count cap, size cap and read/extraction failure Toast | Composer validation / operation failure | Composer feedback; preserve accepted-file Toast confirmations |
| `_toggleMsgFav` | success and failure share Toast; rejected favorites promises can escape | success confirmation / operation failure | Keep success Toast; catch/report failed operation through IBERR/Error Disclosure |
| `deleteSingleMsg` | DB rejection is Toast-only | destructive operation failure | Keep immediate-delete semantics; message-context IBERR disclosure, no new confirm/retry action |
| `continueTruncatedMsg` preflight | missing message, sealed boundary and missing speaker API config use Toast | continuation validation | Keep distinct “continue” owner/label; show scoped explanation, never generic Retry |
| `continueTruncatedMsg` provider catch | existing IBERR global disclosure; Toast fallback | continuation operation failure | Preserve IBERR and continuation semantics; surface a message-context failure and re-enable the existing Continue action |
| Local Qwen/image-route progress/failure Toasts | “正在识别” / local vision failure and capability notices inside the Image Router path | feature-owned long task / image capability | Keep Image Router as owner; migrate only if needed for Chat’s error boundary, never create a second image state owner |
| Favorite/delete/export/clear/attachment success Toasts | brief completion confirmation | success | Keep as success confirmation; no global Toast cleanup |

Existing `copy`, `edit`, `reply`, `regenerate`, and manual Retry have no UI owner and stay N/A. No provider auto-retry is exposed as a button. `continueTruncatedMsg` remains a continuation action with its current message and provider owner.

## 31. D4.1-C Implementation Closure

本节冻结本轮对真实状态的呈现映射。所有新 DOM 都是读现有信号的 presentation adapter；没有新增 Chat state store、event bus、message status 或 group planner。

### 31.1 State Owner 与呈现映射

| State | Owner / source | C presentation | Lifetime / persistence |
|---|---|---|---|
| sending | `social.js` 的 `_chatSendingFor` Set；`sendChatMessage` 在真实请求区间 add/delete | `_chatSyncComposerBusy` 只读 `.has(activeFriendId)`；当前 Composer `aria-busy`、`data-activity-state=sending`，当前 Send disabled；Conversation Selector 投影切换后重新同步 | 锁随既有单聊/群聊收尾移除；不写消息状态 |
| typing | `IBDeliveryRuntime` 的 bounded `typingOn` 回调；communication 的 `_ibTypingOn/_ibTypingOff` 仍是 DOM adapter | 当前消息流显示 speaker 名 + 正在输入；单例；`role=status`、`aria-live=polite`；计时器对读屏隐藏 | runtime 的真实 delivering 阶段才出现；unit 写入前关闭，cancel/fail/finish 关闭；队列仍仅在内存 |
| thinking | 非流式 `sendChatMessage` / 当前 group member 的请求阶段；流式 reasoning 只来自既有 `onThink` 并受 `showThinking` 控制 | 活动消息附近显示名 + 正在思考；完整思考文本仍需用户打开原有 disclosure；stream raw reasoning 不自动播报 | 请求结束、切换或错误清理；reasoning 与 reply 继续分开保存 |
| streaming | `callApiChatStream` 的 `onChunk`；临时 `_createStreamBubble` 与现有分段解析器 | 活动消息内一个 `status` 文本；不把 token 内容放进 live region；`.r-text` 为 `aria-live=off`。前缀确认不是 `<think>` 标签后，即使短回复仍转为“正在回复” | 真正的 stream callback 期间；success/error/stop 清除状态节点；最终消息只按既有路径落库一次 |
| stopping | `stopStreaming` 读取 `_chatCallStates` 的 AbortController/stopped；GroupTurn 与 delivery abort 仍由原 owner 管理 | 只在 controller 仍活动时，将对应 stream 状态短暂改为“正在停止…” | abort catch/finalize 后清除；无持久 stopped 状态 |
| retrying | provider 内部的协议重试/自动续接仍由原请求 owner 控制；截断 continuation 由 `workspace.js` `continueTruncatedMsg` + `_contBusy` 防重复 | 不暴露 provider retry；原有按钮仍叫“继续生成”，请求期间 `aria-busy` 并 disabled | continuation 更新原消息；失败恢复原按钮且原文本保留；没有 generic Retry |
| error | `IBERR` 继续拥有分类、用户文案、脱敏与技术详情；请求/历史/消息操作仍由各自 catch/read boundary 发现 | Composer 校验回到 Form feedback；发送/续写/消息操作进入当前消息流的 IBERR 派生 L1 Error Disclosure；历史读取使用会话级错误和真实“重试读取”动作；L3 只通过 IBERR disclosure 主动打开 | 错误呈现是 DOM，不是 canonical `message.status`；不伪造 assistant error row |
| idle | 无独立 owner；由没有活动请求、typing callback、stream node 与 GroupTurn 执行推导 | 不显示 online、ready、active speaker 或 idle badge | 无持久字段 |

`_chatSyncComposerBusy` 不创建或写入第二个发送锁；stream presentation 不改变 `callApiChatStream` 的内容解析/取消/最终写入；group 活动读当前 `cfg.id` 和已计划的顺序。

### 31.2 Failure 与 Recovery

| Failure | C L1 与恢复 | L3 / 按钮语义 |
|---|---|---|
| 空消息、图片类型/尺寸/数量/读取、文件数量/大小/读取 | 当前 mini/full Composer 内联反馈；校验失败不新增 pending attachment | 不使用失败 Toast |
| 单聊/群聊 provider send | 错误靠近发起该轮的会话消息，说明影响与下一步；没有 transient assistant error row | “查看技术详情”调用 IBERR；details 默认折叠；不显示 Retry |
| mini/full 历史读取失败 | 会话级“无法加载对话记录”；可真实重新读取，不发送消息 | IBERR 技术详情默认折叠；历史重试仅重读原 owner |
| group planner 空计划 / runtime 起不来 | 单条可读 Inline Status；避免 Toast 与重复系统行 | 不从计划项推断在线/活跃 |
| 单/批量删除与收藏写入失败 | 说明记录仍保留或收藏未改变；批量部分成功如实报告数量 | 沿用 DB 与 `IB.favorites` owner；不新加确认或 retry subsystem |
| 截断 continuation provider/write failure | 原消息内容与 truncated 状态保留；显示 continuation 专属说明；恢复原“继续生成”按钮 | continuation 不是 Retry；L3 经 IBERR 主动展开 |
| local vision failure/capability | 仍在原 Chat/Image Router consumer 处表达；本地失败告诉用户回复不会依据图像内容 | 不创建第二套 vision task state |

重复错误报告的 IBERR 去重仍可抑制重复全局提醒；每个新 user turn 的消息级 L1 不因此消失。成功确认 Toast 保留；本轮只迁移上述 Chat consumer，不清理全仓 Toast。

### 31.3 Message Actions

| Action | 分类 | C result |
|---|---|---|
| Favorite | CONTEXTUAL，高频可直接发现 | 保留星标；button name/`aria-pressed` 与 `IB.favorites` 结果同步；成功 Toast 保留 |
| Delete one | CONTEXTUAL + DESTRUCTIVE | 置于 native `popover=auto` 的 More；立即删除语义不变；focus 回到消息流；失败是消息上下文 IBERR Disclosure |
| Select / bulk delete | CONTEXTUAL + DESTRUCTIVE | selection authority 仍是 `memory.js` 的 `_chatSelectedIds`；变成原生 button，pressed 状态、可读名称、44 CSS px hit target；bulk 部分失败进入 Error Disclosure |
| Continue truncated | CONTEXTUAL / execution | label 仍是“继续生成”；可读名称；等待态准确并在失败后恢复 |
| Copy / Edit / Reply / Regenerate / manual Retry | N/A | 本仓库当前 Chat UI 没有这些 action owner，不添加 |

全屏和 mini Chat 共享同一 action adapter。Favorite 与 More 是可触达按钮，不依赖 hover；More/删除至少 48 CSS px 基础目标（mini 面板当前 0.95 缩放后实测仍超过 44 CSS px）；popover 使用 D2 lifecycle，ARIA expanded、键盘 Enter、Escape、焦点恢复和视口边界均有浏览器断言。选择控件也是 native button。没有声称 `role=menu`，Popover 内保留普通 button 语义。

### 31.4 Multi-role 与高级上下文

- Speaker identity 只用 canonical `speakerId/config_id`；`senderName` 仅用于可见名称和 legacy 内容展示。临时 stream bubble 的 `data-sender-id` 也使用 canonical id；名字不是身份 key。
- Active activity 紧贴当前 member 的消息流；runtime turn 结束即删除。两名 speaker 的 stream 请求顺序与 planner 的 A→B 顺序一致；A→B→A 历史行保留三段可识别身份；idle 时没有 active-speaker UI。
- 不引入 speaker color map、彩色 role badge、group-wide active state，也不预创建/合并/重排/提前持久化消息。
- L1 是身份、用户消息、真实 activity、用户下一步；L2 仅进入已有 thinking disclosure/Chat context；L3 provider、endpoint、request、trace 仍通过 IBERR 技术详情显式进入。没有新建 Settings subsystem 或把技术项放回 Header。

### 31.5 Accessibility、Responsive、Theme 与 Motion

- Activity 文案独立可读且只在状态转换时播报；typing/thinking 是单一 status；stream 文本不逐 token live announce；结束态取消活动属性，mini 保留的短暂用时文案已退出 live-region/state 语义。
- Error recovery 有真实按钮名；技术细节默认折叠；continuation 不冒充 Retry。
- 320、375、390、768px 浏览器 gate 全通过；latest metrics 的 document scroll width 分别 316、371、386、764px；320px 输入区宽 142px、send/attach/voice/sticker 44×44；选择控件/消息 actions 独立测量 hit target。
- Internal/Infernal 共用 DOM、IA、actions、status 与 error pattern；只有 semantic tokens 改变配色。`prefers-reduced-motion: reduce` 下 activity 文本仍在、状态仍清楚、stream cursor 动画停止。
- Browser screenshot harness 在 Chat 截图前关闭 Calendar 独立窗口；global mobile Shell/Room rail 仍是既有 deferred surface，不在 C 改结构或层级。内部/Infernal 页面及窄屏截图已人工检查；底层 Chat 内容、selector 与 composer 保持可读/可用。
- axe-core 未运行：本机 `IB_AXE_CORE_PATH` 未设置，仓库也没有 axe browser bundle；键盘、ARIA、live-region 与 target gates 已由 Chat smoke 和 D2 overlay/primitives suites 覆盖。D4.1-D 可在接入 axe bundle 后补测。

### 31.6 Owner Preservation 与 Regression

新增 `tests/test_chat_state_presentation_authority.js`：**13 checks pass**，覆盖 sending lock、delivery typing、thinking display adapter、stream callbacks/transient node、Stop abort、唯一 group planner、friend/thread selection pointers、canonical message persistence、favorites 和 existing message selection owner。`tests/test_delivery_runtime.js`: **161 pass**。最终 `tests/test_chat_smoke.js`: **PASS**，包含 single/mini activity/error/actions、history recovery、continuation、320/375/390/768 responsive、Internal/Infernal、group A→B、stop/cleanup、persist-once 与无 JS exception。`tests/test_group_dynamic_runtime.js`: **194 pass**；`tests/test_group_speaker_identity.js`: **50 pass**；`tests/test_group_participation_planner.js`、`test_group_turn_identity.js`、provider wire-format、lazy injection、message sequence、Chat authority/migration、navigation、Home、UI primitives (**38**) 与 UI overlays (**39**) 均通过。group dynamic guard 只改为读取 canonical `webcore-db-schema.js` 的版本常量，DB schema 未改。

| Known gate | C result | Delta / note |
|---|---|---|
| `test_chat_core_contract.js` | 90 pass / 1 fail | 与 C entry baseline **完全相同**。测试仍从 `core.js` 搜 literal `DB_VER=...`；生产 `core.js` 现在引用 `IBWebCoreDbSchema.DB_VERSION`（24）。不改 schema 或该冻结 baseline |
| `test_frontend_structure.js` | 2 failures | 与前序 baseline 相同：`memory-authority.js` BOM、Image Router credential-origin wording；Chat CSS UTF-8/BOM 检查通过 |
| `scripts/ui-guardrail.js check` | 当前报告 1 条 memory-authority BOM baseline | Chat-family CSS debt delta = **0**；gradient 214、backdropFilter 109、bgRgba 31、bgHex 11、smallFont 12、bigRadius 18、important 59、rawHex 127、violet 0，与 D4.1-B 记录一致；新 Chat CSS 无 raw color/glass/arbitrary radius-shadow-motion/literal z-index/`!important` |
| `git diff --check` | pass | 仅现存 CRLF/LF advisory，无 whitespace error |

Browser evidence 位于本次 smoke 输出目录（`ib-chat-d41-b-evidence-*`）：1280 Internal/Infernal、390 Internal/Infernal、320 Internal 与 group multi-role。Profile 和合成 DB rows 由 smoke teardown 清除；生产 Chat runtime/database 未接收测试专属 state。

### 31.7 D4.1-D Handoff

D4.1-C 的状态、错误、动作和 multi-role 设计冻结。D4.1-D 只做 final browser acceptance、authority audit、Regression freeze 和 Chat Family closure；不得继续设计/扩展 C 的行为。Calendar overlay、global/mobile Shell、mini Chat legacy glass、Android 与 D4.2 Personal Space 仍 deferred。

**Phase decision: D4.1-C COMPLETE — CHAT FINAL ACCEPTANCE MAY PROCEED**

\n