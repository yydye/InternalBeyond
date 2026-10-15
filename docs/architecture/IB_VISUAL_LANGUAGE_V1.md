# IB Visual Language v1

- 状态：**已冻结（Frozen）**
- 版本日期：2026-10-02
- 适用范围：InternalBeyond / Project-IB 的新界面、重构和后续视觉迁移
规范权威：本文件。生产 token 的现有实现位置仍是 `assets/css/core.css`；迁移期间保持兼容，不要求全仓重命名。

> **保留血统，停止模仿。**
>
> **一眼简单，深入无底。**

## 1. Purpose

InternalBeyond 已从角色聊天应用成长为 Personal Agent Workspace / Personal Computing Environment。它承载对话、记忆、角色关系、创作、语音、运行中的任务，以及用户日常使用的系统能力。

IB Visual Language v1 定义这些能力如何共同呈现。它服务整套产品，不围绕某一张 Home 页面、原版页面骨架或某个外部产品造型展开。

本文件同时包含：

- IB 的规范：以后新增和迁移的视觉决策以此为准。
- 现状审计：只读检查当前工作树中的 UI 结构和可复用规则。
- 差距地图与迁移顺序：记录实现逐步达到规范的路线。

## 2. Product context and historical relationship

### 2.1 当前产品

IB 是一个带有私人内容和个人计算能力的环境。聊天、角色、记忆、书信、时刻、创作和共读是个人空间；Middle Brain、凭据、系统服务、Economy、Packaging、Diagnostics 是系统空间。它们共用一个产品和一套交互语言。

当前桌面 Web UI 仍以 `InternalBeyond.html` 作为路由 DOM 容器，样式和行为已拆到多份共享及模块 CSS/JS。Android 客户端另有 Compose theme 与共用组件。新视觉规范不依赖单文件 DOM；未来页面可以由任何宿主实现。

### 2.2 原版定位

原版 InternalBeyond 是历史参考，用于识别 IB 的情绪、文字和关系感。它不是当前信息架构或默认页面模板。

值得延续的 DNA：

- Internal 的雾蓝与 Infernal 的深夜蓝构成同一主题的两个方向。
- 对话、角色和用户内容处于视觉中心。
- 衬线字承接品牌、阅读和叙事；无衬线字承接操作和系统信息。
- 文字节奏安静、私密，重要关系可以有温度。
- 场景视觉可以承载确实存在的记忆、共读或电影内容。

作为历史实现保留但不作为默认模板的内容：

- 全屏品牌欢迎页、单文件时期的页面骨架和功能塞入方式。
- 背景雨、花瓣、星点呼吸、全局长时间雾化过渡等持续装饰。
- 以玻璃表面、发光和大圆角代表 IB 身份的做法。

品牌欢迎页可以留作明确的欢迎或叙事页面。普通产品进入点应展示用户可继续的工作。

### 2.3 决策权威

1. 本文件决定新界面的视觉与信息呈现规则。
2. [IB Visual Token Contract v1](IB_VISUAL_TOKEN_CONTRACT_V1.md) 定义语义 token 与 Web / Android 映射；core.css 继续提供 Web 运行时值。
3. 既有页面、迁移报告、原版实现和外部参考是审计证据，不覆盖本规范。
4. 页面如需例外，必须指出用户任务、语义理由、影响范围和退出条件；“品牌感”“更高级”“更有未来感”不能单独构成理由。

## 3. Design philosophy

IB 的默认界面应当一眼可懂。内容和当前状态建立第一层意义；需要时，用户再展开高级选择和技术细节。视觉深度来自内容关系、实时状态和用户自己的数据。

全产品的优先顺序：

```
内容 > 容器
排版 > 描边
空间 > 卡片
状态 > 装饰
层级 > 阴影
```

Surface 是承载语义的结构，不是默认皮肤。留白是分组工具，不用空旷来掩饰缺少任务内容。

## 4. Five core qualities

| Qualities | IB 中的可执行含义 | 评审问题 |
|---|---|---|
| **Quiet** | 先移除没有语义作用的边框、底色、阴影、渐变和说明文字。一次只突出一个主要任务或对象。 | 去掉容器后，层级是否仍然清楚？ |
| **Spatial** | 通过间距、对齐、宽度、分组和固定/滚动关系构成页面。 | 用户能否看懂哪里是导航、工作内容和可选详情？ |
| **Alive** | 用真实 presence、typing、thinking、running、sync 和连接状态表达系统活动。 | 动效或状态变化是否对应一个真实事件？ |
| **Personal** | 个性来自角色、头像、关系、消息、时间和用户保存的内容。 | 移除装饰后，页面是否仍能感觉是用户自己的 IB？ |
| **Deep** | 首屏只呈现当前任务需要的信息；高级行为与完整技术上下文可被用户主动打开。 | 用户是否能先完成常见任务，再自行深入？ |

## 5. Frozen design principles

以下八条冻结为 v1 原则。System Space 与 Personal Space 的差异由 Layout、Density 和内容呈现规则承载，不另建一组口号。

1. **Content before chrome** — 内容优先于装饰。
2. **Space before containers** — 优先通过空间表达结构。
3. **State is visual** — 可用性和真实活动本身就是视觉信息。
4. **Complexity on demand** — 复杂度只在用户需要时出现。
5. **Motion means activity** — 动效表达真实活动或结构变化。
6. **Personal, not decorative** — 个性来自用户、角色与内容。
7. **Simple at first glance, deep on demand** — 默认简单，允许深入。
8. **Technical never leads** — 技术信息不能主导默认界面。

## 6. Information depth grammar

每个页面、组件、状态、表单和错误都要能说明自身处于哪一层。

| Layer | 用户看到什么 | 允许的信息 | 默认呈现 |
|---|---|---|---|
| **L1 · Human** | 现在的状态、发生的事、能不能继续、下一步动作 | 日常任务、用户友好名称、清楚的状态和时间、恢复操作 | 页面默认层 |
| **L2 · Advanced** | 用户打开高级设置后能调整的行为 | 模型能力的友好名称、模式、策略、思考深度、图片能力、高级行为 | 明确的“高级设置”或同等主动入口后 |
| **L3 · Technical** | 用户进入技术详情、Diagnostics、Developer、Debug 或 Runtime details 后可排障的上下文 | credentialRef、provider id、endpoint、model id、request id、latency、runtime、trace、raw error、adapter、authority、internal route | 默认隐藏；用户主动进入技术上下文后可见 |

### 6.1 Technical first-screen hard constraint

> **Technical information must never appear on the first screen unless it is required to resolve an active problem.**
>
> **除非正在处理故障，否则技术信息永远不能出现在第一屏。**

这里的“第一屏”是用户进入普通页面或打开常见任务时，不滚动、不展开详情所见的默认内容。页面不得默认露出 credentialRef、provider 内部 ID、endpoint、model ID、latency、trace、raw runtime、authority 或内部路由。

用户主动进入 Diagnostics / Technical Details / Developer / Debug / Runtime details 后，该明确打开的技术上下文可显示 L3。当前故障卡片可先显示恢复必需的信息；完整技术上下文仍在折叠详情中。应用内部为定位问题而记录的数据不因此成为 L1 UI。

### 6.2 Layer ownership

- 每段信息有唯一默认层级。某个字段在一个模块里属于 L3，不会因为它被复制到另一张卡片就变成 L1。
- L2 与 L3 必须由用户动作进入；仅滚动到页面某处不算主动进入。
- 数据层可以保留完整值；展示层负责友好映射、脱敏和 disclosure。
- 用户明确打开 L3 后，技术字段仍须有可辨识的标签、复制能力和脱敏边界。

## 7. First-screen contract

每个普通页面首屏优先回答：

1. 我在哪里？
2. 当前状态是什么？
3. 这里最重要的内容是什么？
4. 我下一步可以做什么？

首屏结构建议：一个简短的页面标题或上下文标记、一个主内容区域、与当前状态相称的下一步操作。工作页面直接开始工作；只在导览、欢迎、角色/profile 时刻和叙事场景使用 Hero。

首屏不放技术元数据、帮助长文、重复标题、巨型 Hero、设置摘要、provider / endpoint / runtime、无必要状态卡或大量入口卡。若用户确实需要说明，贴近对应控件给出一句具体帮助，默认收起次要解释。

## 8. Foundation

### 8.1 Typography

| Role | Family | v1 size / weight | Use |
|---|---|---|---|
| UI / body | Noto Sans SC 或系统 sans fallback | 正文 14–16 px，400 常规；操作状态 400–500 | 页面、按钮、表单、系统状态 |
| Page title | UI sans；语义需要时用 Noto Serif SC | 20–24 px，400–500 | 说明当前位置，不做品牌 Hero |
| Section title | UI sans 或 Noto Serif SC | 16–18 px，500 | 分区层级 |
| Reading | Noto Serif SC | 正文 15–17 px；行高 1.7–1.9 | Letters、长文、回忆、共读 |
| IB identity | Cormorant Garamond + Noto Serif SC | 仅少数身份/叙事时刻 | 品牌字、章节语气；不用于密集操作标签 |
| Technical | Fira Code 或系统等宽字体 | 至少 12 px，400 | 仅 L3 的代码、ID、trace 和原始值 |

规则：

- 正文优先清晰度，不用 300 字重或透明度营造朦胧感。
- L1 次级文字至少 12 px，普通正文至少 14 px；任何密度都不通过缩小正文来获得空间。
- 行长：常规正文约 45–75 个拉丁字符等价宽度；长阅读控制在 60–75ch。
- 大写与宽字距只用于很短的栏目标签；不把每个标题、按钮或状态都做成 caps label。
- Icon 默认 16 px，主要操作最多 20 px。图标只辅助辨认；文字标签和无障碍名称仍然完整。

当前基线在 `core.css` 中定义 `--font-ui`、`--font-display`、`--font-reading` 和四级字号。现有 `--fs-body: .86rem` 与 `--fs-meta: .74rem` 在 16 px root 下略低于上述 14/12 px 目标；后续 token 落地时统一桥接，不在本规范阶段改 CSS。

### 8.2 Spacing and density

现有 4 px 基线继续作为兼容刻度：4 / 8 / 12 / 16 / 20 / 24 / 32 px。组件尺寸从这组刻度组合，不为单页随意加一套间距。

| Density | Typical spacing | Used for |
|---|---|---|
| **Relaxed** | 内容块间 24–32 px；长文行高 1.7–1.9 | Letters、Moments 阅读、记忆浏览、个人资料 |
| **Standard** | 分组间 16–24 px；控件间 8–16 px | Home、Chat、角色空间、日常操作 |
| **Dense** | 分组间 12–16 px；字段间 8–12 px；正文尺寸保持不变 | System settings、Economy、Packaging、Diagnostics |

密度改变空隙、排列和次要信息展示，不改变产品色彩、字体身份、状态语义和 Surface 规则。窄屏可折叠次要信息或进入单列，不压缩文字到不可读。

### 8.3 Color semantics and background hierarchy

颜色由语义角色驱动；主题只给角色提供值，不能改变信息结构。

| Role | Meaning |
|---|---|
| Canvas | 页面唯一的基础背景。Internal 保留浅雾蓝取向；Infernal 保留深海军蓝取向。 |
| Primary / Secondary / Muted content | 阅读层次。层次优先通过字号、字重、间距建立；Muted 不能使信息失去可读性。 |
| Accent / Accent-soft | 可操作的重点、选择和链接；当前蓝色族 `#5080b0 / #72a8d8` 可保留在 token 内。 |
| Boundary | 只表示确有语义边界的分隔或控件边缘；首选发丝线。 |
| Success / Info / Warning / Danger | 反馈真实状态，配合状态名、图标或说明，不单靠颜色传意。 |
| Beyond accent | 暗色主题中的稀少叙事色；酒红色保留给明确的 Beyond / 角色时刻，不作为一般错误色或模块色。 |

- 同一语义在 Internal、Infernal、Android 和 Web 上含义一致；对比度随背景满足常规文字至少 4.5:1、大字及非文本关键边界至少 3:1。
- 禁止纯黑或纯白作为大面积主题底色；禁止用每模块一套 accent。
- 背景图或场景色只在内容需要该场景时出现。全局页面结构不能依赖照片、全屏雾层、滤镜或渐变来获得可读性。
- 透明度用于表面填充，不用于让正文或必须可读的状态变淡。Muted 内容由语义色定义。

### 8.4 Radius, border, shadow, opacity

- 圆角分级上限：紧凑标记约 4 px，常规控件 6–8 px，内容 Surface 8–12 px，Dialog 12–16 px。圆形只用于圆形头像/状态点；胶囊只用于很短且可选的标记。
- 边界使用 1 px hairline 或留白分隔。只有真实交互边界、焦点、选择或独立对象才出现描边。
- 普通内容 Surface 默认无阴影。Popover、Dialog 等具有明确空间层级的临时浮层才用对应阴影；阴影不得承担唯一的状态信息。
- 一个元素默认不同时叠加不透明背景、边框和阴影。只有评审能说清三者各自承担什么角色时才可同时使用。
- 将现有 `--radius-*` / `--border-*` / `--shadow-*` 作为兼容入口映射到这些语义角色；不在本轮全量替换。

### 8.5 Opacity and icon sizing

表面透明度、边界对比和字色属于主题 token；组件不直接抄 raw RGBA/hex。交互目标在触屏上至少 44 × 44 CSS px；Android 至少 48 × 48 dp。图标视觉尺寸与点击区域分开设置。

## 9. Layout grammar

### 9.1 App Shell and navigation

IB 使用一个稳定的应用壳：主导航、当前工作区、可选的上下文检查器。IB 只维护一套导航信息架构和路由层级；不同屏幕尺寸允许使用适合设备的导航呈现方式，但不得形成独立的信息架构。

- 宽桌面：左侧导航轨约 220–240 px；用户选择折叠后约 64–72 px。轨道承担一级地方，不列出每个按钮、状态或技术能力。
- 中等宽度：收起导航标签或把导航移入一个明确的临时菜单；主内容区保持完整，不同时缩小导航和内容。
- 窄屏：顶部上下文栏和适合单手的主导航；其余路线从明确的导航入口进入。禁止把桌面三栏缩小到手机宽度。
- Top / contextual header 只显示当前页面需要的标题、主要操作和状态。已有导航已明确当前地点时，不重复显示第二个大标题。
- Inspector 是可选上下文面板，常规宽度约 280–360 px。默认关闭；它承载当前对象的次要信息或 L2/L3 详情，不常驻抢主区空间。
- Sidebar、主区和 Inspector 分别有固定/滚动边界；同一屏幕只有一个主滚动区，浮层不会遮挡主要恢复操作。

### 9.2 Page width and columns

- **1-column** 是默认。用于阅读、表单、时间线和顺序任务。
- **2-column** 只在两块内容需同时比较或一块是稳定次要上下文时使用；窗口变窄即转为单列。
- **Split view / master-detail** 用于选择一个对象后在旁边查看其详情，例如 Chat 的会话列表与当前对话。窄屏只保留一个主 Surface，并通过导航/返回切换列表和详情。
- **Inspector** 用于当前对象的次要操作或信息，不用于把完整高级设置永久放在首屏。
- **Overlay** 用于短暂、可返回的上下文工作，如 Popover、菜单、Sheet；可滚动长流程使用独立页面。
- **Dialog** 只用于需要用户决定才能继续的短任务、不可逆动作确认或模态系统状态。
- 长阅读 max-width 42–48rem；标准工作页 max-width 68–72rem；Chat、Cinema、Canvas、桌面多列工作区可占满主区。

## 10. Surface grammar

### 10.1 Surface creation test

新增 Surface 之前回答：它代表哪个独立对象、任务、选择或空间边界？如果答案只有“把内容装起来”，删除容器并使用标题、间距、对齐或分隔线。

同一内容语义不能先有一个有边界的卡片，再在里面套另一个有边界的卡片。内部控件、分区和说明默认直接排在父内容区内，以行、标题和 hairline 分隔。

### 10.2 Roles

| Role | Meaning | Default treatment |
|---|---|---|
| **World / Canvas** | 页面底层阅读空间 | 一张稳定主题底，不叠装饰材质 |
| **Section** | 页面内同一任务或信息组 | 透明背景；用标题、间距、对齐、列表和分隔线 |
| **Surface** | 有独立边界的对象或短任务 | 仅在边界帮助理解对象归属、操作或状态时使用 |
| **Interactive Surface** | 整体可被打开、选择或操作的对象 | 提供明确 hover/focus/pressed/selected 状态；其内部子区不再叠同等级容器 |
| **Selected Surface** | 用户当前选择对象 | 用 accent 线/轻填充/文字状态表达；不同时堆叠多种强调 |
| **Elevated Surface** | 临时浮起或工具层 | 仅用于浮窗、Popover、Inspector 或真实悬浮控件 |
| **Overlay** | 遮挡背景以建立临时上下文 | 控制遮罩强度，保持用户知道返回路径 |
| **Dialog** | 阻断式短决策或确认 | 单一问题、清楚结果、一个主操作与一个退出/取消操作 |
| **Popover** | 锚定到触发控件的小型上下文 | 短、就地、可通过 Escape/外部关闭 |
| **Toast** | 已完成的短暂确认 | 不承担错误恢复、持续状态或唯一结果通知 |

玻璃只可用在具有真实层次关系的少数 Elevated Surface / Overlay / Dialog。页面普通正文、Section、每行设置和信息卡不因 IB 气质自动获得玻璃背景。业务图表可用颜色表达数据，但不借此创造一个无意义容器。

## 11. State grammar

状态名的语义跨模块一致；运行时可以保留业务自己的状态值，再统一映射到视觉角色。颜色以 `--status-success/info/warning/danger` 及中性内容 token 表达。

| State | Meaning | Visual response |
|---|---|---|
| idle | 可操作但当前无活动 | 稳定的中性内容，不动画 |
| active | 用户当前选择或目标正在使用 | 清楚、持续但克制的选择标记 |
| loading | 正等待一个真实操作结果 | 附着到操作或内容的进度；无真实活动时不显示 |
| thinking | Agent 正在思考 | 指明对应角色/任务，使用有因果的活动状态 |
| typing | 角色正在输入 | 放在该角色/会话附近；状态结束即停止 |
| running | 任务实际执行中 | 展示当前步骤、可取消性或明确的不确定状态 |
| syncing | 正在同步 | 说明同步对象与当前阶段 |
| connected | 服务/设备可用 | 成功状态只在确认后显示 |
| degraded | 部分能力不可用 | 说清受影响的能力和可用替代动作 |
| offline | 当前不可连接或无网络 | 说明影响与可恢复动作 |
| warning | 需要注意，但任务还能继续 | 一句原因和相关动作；不用危险错误红替代 |
| error | 当前操作失败或能力不可用 | 稳定可读、可恢复；必要时附技术详情 disclosure |
| success | 操作已完成 | 短暂或贴近对象显示，不重复庆祝动画 |
| disabled | 当前不可操作 | 说明原因或前置条件；不要只靠降低 opacity |

规则：

- 状态不仅是颜色；文本、图标、位置或语义标签至少再提供一种线索。
- 同一状态不得在不同模块重新发明颜色、脉冲、badge 和动画。
- 不用每个状态都配一个 pill/badge；只有该状态需常驻扫读时才显示紧凑标记。
- L1 显示可用性含义；错误码、原因链和 runtime 细节留给 L3。

## 12. Interaction grammar

| Interaction | Rule |
|---|---|
| Hover | 仅针对真实可交互元素，轻微变化其填充/文字；不抬升所有卡片，不显示唯一操作提示。 |
| Focus | 键盘焦点清晰可见，持续使用主题 focus token；不能被阴影或动画代替。 |
| Selected | 表示当前对象/路线；离开 hover 后仍然可辨认。 |
| Pressed | 只在按下期间反馈，不缩放整页对象，不弹跳。 |
| Disabled | 不响应输入；文本保持可读，必要时说明原因。 |
| Drag | 只有对象确实可拖动时才显示抓取 affordance；拖动开始、落点和取消均有结构反馈。 |
| Expand / Collapse | 控件名称与 `aria-expanded` 一致；状态变化附着在被展开内容，支持键盘并尊重 reduced motion。 |
| Context menu | 由清楚的目标和动作触发；关键操作也能通过可发现的普通入口执行。 |
| Inline edit | 进入、保存、取消、失败都有文本状态；编辑内容失焦时不静默丢弃。 |
| Destructive action | 标明影响对象与后果；仅不可逆或高影响动作要求确认。 |
| Confirmation | 可恢复动作提供 undo；成功 toast 可补充确认，不能成为唯一持久记录。 |

任何重要操作不依赖 hover 才能发现。触控和键盘行为属于组件契约。

## 13. Motion grammar

动效必须对应真实事件、因果关系或空间关系。默认无动画。

| Tier | Duration | Use |
|---|---:|---|
| Micro | 120–180 ms | focus、pressed、轻量颜色/透明度变化 |
| State | 160–240 ms | presence、loading、connected 状态变化 |
| Structural | 220–320 ms，最多 350 ms | expand/collapse、popover、drawer、页面切换 |

- 缓动沿用统一的减速/标准曲线 token；组件不自创 bounce、spring、长延时和各自的 easing 家族。
- Theme 切换是语义状态切换，使用快速柔和过渡；不让用户等待数秒看背景溶解。
- Spinner/进度只在真实 loading/running 期间出现；完成或取消时停止。无法确定进度时明确显示 indeterminate，不伪造百分比。
- Presence、typing、task progress、sync、connection 可使用运动，因为它们表示真实活动。
- 禁止无语义漂浮、呼吸发光、perpetual gradient、装饰粒子、自动循环星云和纯装饰页面转场。
- 遵守 `prefers-reduced-motion`；减少运动不隐藏状态或降低信息。

## 14. System Space and Personal Space

两者共用字号、色彩角色、导航、Surface、状态、焦点、输入、动效和错误 grammar。

| Space | Typical areas | Rhythm |
|---|---|---|
| **Personal Space** | Chat、Letters、Moments、Blog、Favorites、Role DM、Diary、Cinema、个人资料 | 内容与阅读优先；行长舒适；有呼吸感；角色、时间与用户内容可以成为重点 |
| **System Space** | API、Middle Brain、Memory System settings、Economy、Credential Authority、Home Node、Packaging、Diagnostics、Runtime settings | 分组紧凑、标签准确、表格/列表清晰；状态和安全后果优先 |

Memory 是交叉区：记忆内容属于个人内容；预算、同步、存储、注入规则和权限属于系统信息，应通过用户主动进入的设置/高级层查看。Density 可不同，语义语言不能不同。新增模块不注册新色系、新状态徽标、新导航或独立圆角体系。

## 15. Error presentation

错误按固定顺序呈现：

```
Human explanation
↓
Recovery action
↓
Technical details
```

1. 先用用户理解的标题与一句原因说明“发生了什么、影响哪里”。
2. 提供能实际执行的恢复操作：重试、重新配置、打开设置、打开系统诊断，或明确说明当前没有自动恢复。
3. 默认折叠技术详情。用户展开后才出现错误码、endpoint、request id、trace 等；密钥与隐私数据必须脱敏。
4. 若错误会导致工作不可恢复或继续有风险，错误说明和恢复路径必须保持可见，不能只靠短暂 Toast。
5. 一次错误不能同时在 Toast、卡片、Modal 和状态栏重复显示同一段文案；各入口说明不同影响时才可并存。
6. 错误结束后，恢复结果要反馈到原任务/对象附近；需要审计的详细内容进入 Diagnostics。

当前 `assets/js/error-catalog.js` 的统一模型已有 `title / message / suggestion / action / technicalDetails`，详情折叠、脱敏和明确恢复入口，是 v1 应保留并收敛的实现。Diagnostics 应当是完整 L3 入口，不把技术原文提升到 Home 或普通页面。

## 16. Dialog, Popover and Toast

- 普通编辑优先放在当前页面或轻量侧栏；小型上下文动作用 Popover；长流程用页面。
- Dialog 仅在短暂阻断或高影响决策有意义时出现。一个 Dialog 只聚焦一个决定。
- Overlay 不借助全屏模糊来“增加高级感”；遮挡范围服务于焦点建立。
- Toast 通常表达保存/复制等已完成结果，停留时间不代替持久状态；错误 Toast 不能作为唯一通知。
- 关闭、取消、Escape、返回和点击外部的行为由 Overlay 类型明确规定；不可逆 Dialog 不因误触背景而执行或丢失用户输入。

## 17. Desktop and mobile relationship

Desktop 与 Mobile 使用同一套信息层级、主题角色、交互含义、状态颜色和 Surface grammar。布局根据屏幕改换，不做缩小版和独立品牌版。

### Desktop

- 导航轨、主内容、可选 Inspector 构成一个工作空间。
- 多列只用于可同时理解的关系；主区有明确的最大宽度和自己的滚动边界。
- Hover 是补充反馈；键盘焦点始终可见。

### Mobile

- 一屏一个主要 Surface。导航位于顶部或底部的明确主导航；低频工具进入抽屉或列表。
- Split view 变为列表 ↔ 详情的上下文保留导航；Inspector 变为 Sheet 或详情区。
- 主内容单列；不要求横向滚动来读设置、操作列表或看错误。
- 触控目标至少 44 × 44 CSS px（Android 至少 48 × 48 dp）；功能不依赖 hover。
- Sheet 可承载短上下文任务；长编辑使用独立页面。返回保留前页选择与滚动上下文。
- OS inset、键盘、语音控制和 reduced motion 是同一交互模型的一部分。

## 18. Anti-patterns

以下做法在默认产品 UI 中禁止：

- Card inside Card。
- Glass everywhere。
- Decorative gradients 或全屏持续变化的背景。
- Giant Hero、没有语义需要的超大标题。
- Every section gets a background。
- 默认把 Border + Shadow + Background 同时加到每个容器。
- Technical metadata on first screen。
- 把 Provider ID 当主要标签。
- Excessive pills、badges 或 status chips。
- Repeated section titles。
- Help text explaining obvious UI，或用大段导读代替清晰结构。
- Too many navigation levels 或每个模块独立一套入口。
- Different visual systems per module。
- Decorative motion、无因果无限动画。
- “AI Dashboard” aesthetic：以整屏入口卡、状态卡、指标和大块玻璃面板代替用户正在做的事。
- Blind imitation of Original IB：照抄旧 Hero、旧页面骨架或旧 DOM 限制。
- 把 “Luna style / Apple style / Linear style / Notion style / Discord style / AI style” 等外部标签当设计结论。

星图、日历、Cinema 等内容可用自身真实的数据/媒体构成可视化或场景。它们不能借数据名义加入与内容无关的光点、粒子或循环背景。

## 19. Phase A — Existing visual system audit

### 19.1 当前实现地图

- **Shell and route DOM**：`InternalBeyond.html` 保存 route page、sidebar/top navigation、Home/Workspace、业务主视图和多个弹层。页面切换由 `assets/js/core.js` 的统一路由逻辑处理。
- **Shared tokens/primitives**：`assets/css/core.css` 定义主题、字体、4 px spacing、字号、content/status、surface、border、radius、shadow、motion、focus 和 layer tokens。共享控件包括 `.btn`、`.glass-card`、`.module-intro`、表单、Toast 和 modal 基础。
- **Shared shell**：`assets/css/navigation-shell.css` 集中定义导航。当前工作树在 769 px 及以上使用顶部 cornice；760 px 及以下使用左侧 rail；761–768 px 落在左轨基础样式区。网页 Chat 在 760 px 以下隐藏会话侧栏。
- **Module CSS/JS**：Chat、Memory、API/Middle Brain、Personal Space、Moments、Voice、Activity、Economy、Packaging、Diagnostics 分别拥有局部样式/状态实现；模块数量使语义相近的容器和状态出现不同组合。
- **Android**：`android/app/src/main/java/.../ui/theme` 已拥有独立 `IbColors / IbSpacing / IbShapes / IbTypography` 和公用 Compose 控件。其颜色、间距刻度和 48 dp 点击目标与桌面有对应关系；Android 目前是深色且覆盖功能更窄的独立客户端。
- **Theme**：Web 的 Internal 与 Infernal 共享 CSS 结构并由语义 token 改值。主题人格清楚；一些早期媒体层、页面遮罩和模块覆盖仍直接控制主题氛围。

### 19.2 已形成、值得保留的共同规则

- 两套主题共用语义色、content hierarchy、表单输入、focus ring 和 reduced-motion 支持。
- spacing 有 4 px 基础步进；字体有 UI、identity 和 reading 的分工。
- 活跃路由由一个 dispatcher 切换；语音、Cinema、Middle Brain 等能力可作为上下文能力，而非都强行创建新一级页面。
- `.module-intro` 的透明标题区与下方发丝线提供了无卡片的分区原语；Chat 当前已直接打开工作内容。
- 统一错误模型已经具备友好标题/正文、建议、动作、折叠技术详情和脱敏。
- Packaging 和 Economy 能表达运行步骤、失败和完成状态；星图、日历有可能承担真实数据表达。
- 角色、消息、信件、记忆和时间内容已形成 IB 私人内容层，未来应保留这种以用户内容为中心的表达。

### 19.3 风格来源与冲突

| Source / pattern | Current evidence | v1 treatment |
|---|---|---|
| Original IB DNA | Internal / Infernal 背景、蓝色主题、Cormorant + Noto 字体、角色/阅读内容、原品牌页 | 保留可识别 DNA，品牌页限定在欢迎/叙事语境 |
| Shared token convergence | `core.css` 的语义色、主题状态、spacing、focus、状态色与页面原语 | 保留 token 作为兼容层，扩充语义映射 |
| Glass-first legacy | `.glass-card` 默认同时有填充、描边、模糊、阴影；五阶 Glass ladder；模块已有卡片分区 | 新页面不再把玻璃当默认表面；渐进替换，不批量清空现有页面 |
| Landing/dashboard residue | `#page-home` 首次激活为品牌 Hero；Workspace 又含品牌头、Recent、Quick Access、状态区；Memory 有多组指标 | 保留内容来源，重新决定首屏信息优先级 |
| Per-module presentation | `plate`、`glass-card`、`api-paper`、各模块卡片/Badge/不同 modal 并存 | 抽取共同 grammar；保留不同任务确实需要的布局 |
| Motion as atmosphere | 全局背景过渡最长 4 s、page overlay 约 3 s、Splash 长溶解、Memory 星云与星点循环 | 仅真实活动和结构转场保留运动；装饰性循环不进入新页面 |
| Authority / documentation drift | `NAVIGATION_ARCHITECTURE.md` 记录顶部 cornice + 窄屏左 rail；较早的 `UI-VISUAL-MIGRATION-AUDIT.md` 仍把 P36 左 rail 作为 desktop 基线，当前工作树另有未提交的 More 菜单 | 以当前代码审计实现事实，以本文件决定今后目标；旧文档保留为迁移证据 |
| Luna naming | 搜索到的 “Luna” 命中是模型标识，不构成视觉系统证据 | 不以任何外部产品或角色风格命名 IB 规则 |

历史对齐工作不回滚。已经收敛的字体、颜色、错误、focus、导航和页面组件作为迁移起点；只有违反 v1 的具体默认呈现进入后续页面改造清单。

## 20. Phase C — Current gap map

分类含义：

- **ALIGNED**：主要信息层级与共同 grammar 符合 v1。
- **PARTIAL**：可复用基础已存在，默认结构/状态/密度仍需收敛。
- **LEGACY**：可保留作历史或明确叙事页面，不作为产品任务模板。
- **VIOLATION**：当前默认行为直接破坏 v1 的 hard constraint 或 anti-pattern。

以下结论来自当前工作树 HTML/CSS/JS 和 Android Compose 静态检查。未做浏览器截图；“第一屏”判断基于初始激活页、DOM 顺序、初始 ARIA 展开状态和可见内容规则。

| Area | Status | Evidence and gap |
|---|---|---|
| Navigation / shell | **PARTIAL** | 有单一路由 dispatcher、导航控件与状态；当前桌面顶部导航、窄屏左 rail，Workspace 入口在宽屏隐藏，760–768 px 落在左轨基础样式区。旧迁移报告记录的是另一版桌面 rail，新增 More 菜单也尚未进入历史文档。v1 需统一跨宽度的 shell grammar。 |
| Welcome / original Home | **LEGACY**；作为应用启动页时 **VIOLATION** | 初始 active route 是 `#page-home`，内容为全屏品牌字和 tagline；适合独立 Welcome/Narrative，不能代表默认工作首屏。 |
| Home Workspace | **PARTIAL** | Recent、Quick Access、Workspace Status 用友好文字；有只读聚合。首屏仍重复品牌头、双栏玻璃 Surface、七个快捷入口和四个状态项，缺少当前活跃角色/任务等真实 Presence facade。 |
| Chat | **PARTIAL** | 普通 Chat 直接打开会话工作区；桌面会话列表与对话形成可理解的 master-detail。工具栏控件较密，移动网页隐藏会话列表；Typing/Thinking/Voice 状态需统一到全产品 state grammar。 |
| Personal Space：Blog / Letters / Moments / Favorites / Role DM / Diary | **PARTIAL** | 人、关系、长文、信件和时间内容具备明显 IB DNA；各页仍有长篇 module intro、独立卡片/页头/状态组件，个人区之间的节奏不一致。 |
| Activity / Active / Agent work | **PARTIAL** | 后台计划、主动消息和运行状态属于真实活动；页面用多组 glass cards 与模块自己的状态文案承载，需要统一运行、等待、暂停、失败和恢复语义。 |
| Memory | **VIOLATION** | 星图有实际价向/唤醒轴，可作为数据视图；同一首屏又直接出现总量、token 估算/上限、领域指标和 Quote banner，信息量偏系统面板。星点/星云另含装饰性循环运动。 |
| API / Settings | **VIOLATION** | 页面包含 Endpoint、API Key、Credential Ref、provider 配置和大量说明。Middle Brain 折叠默认关闭，但初次或不完整配置会自动展开；页面没有一致的 L1/L2/L3 入口边界。 |
| Middle Brain | **VIOLATION** | 入口位于 API 页且部分折叠；展开后 endpoint、credentialRef、provider config、model/reasoning ID 与高级策略混排。可保留能力，需先按 Human / Advanced / Technical 重新分层。 |
| Home Node / Desktop Runtime / Bridge / Credential Authority | **PARTIAL** | 连接与凭据操作分布在 API、Bridge 对话框和 Diagnostics；普通用户状态由错误模型部分承接，尚无统一的 Human 状态入口与技术详情层级。 |
| Voice | **PARTIAL** | Voice 接入 Chat 并有来电、通话中、错误、接受/拒绝等真实 runtime 状态，符合 Alive。通话 Overlay 与其它 Dialog、状态反馈和动作密度尚未共享完整 grammar。 |
| Diagnostics / Error model | **ALIGNED**（基础） | Diagnostics 先用基础运行、AI 聊天、可选能力与“正常/需要注意/不可用”状态解释影响；Technical details 可主动打开。IBERR 已提供人话、恢复入口、折叠详情和脱敏。后续需核对视觉原语与可访问性的一致性。 |
| Economy | **PARTIAL** | 页签、钱包、商品、审批等结构有 token 和层级；多套动态模块样式、Surface、标签和状态需要映射到统一 grammar。 |
| Packaging | **PARTIAL** | 任务计划、运行进度、失败/取消和历史构成真实状态流；首屏多组 panel，数值/环境/哈希等技术结果需要随当前任务分层，移动断点单独定义。 |
| Dialog / Popover | **PARTIAL** | 现有通用 `.modal`、Memory overlay、Credential modal、Voice call overlay、Packaging dialog 各有结构；边界、动效、关闭与技术详情的共同规则尚未冻结。 |
| Toast | **VIOLATION** when used for failure/recovery | 全局 toast 约 2.8 s 自动移除；可用于简单成功确认，不能承担错误解释、恢复或唯一状态留痕。部分现有错误路径仍会 Toast。 |
| Web mobile layout | **VIOLATION** against the v1 mobile contract | 当前 ≤760 px 仍以窄左 rail 为基础；许多控件小于 44 px；Chat 隐藏会话列表；不同页各自用 560/600/640/760/820/900 px 断点，缺少全局 mobile grammar。 |
| Android client | **PARTIAL** | 有独立 palette/spacing/shapes/type 和通用控件，触控目标 48 dp；目前仅深色、功能范围较窄，圆角最大达 28 dp，配对页还使用额外 indigo/violet 环境色，尚未证明全产品共用 v1 信息层级。 |
| Apps / Cinema / Co-read | **PARTIAL** | 作为应用内真实内容或沉浸场景有合理独立布局；应用入口、Host surface 与普通模块间的导航/返回关系需在 Family Migration 阶段统一。 |

## 21. Phase D — Migration plan

迁移遵循：

```
Visual Language
↓
Tokens
↓
Primitives
↓
Reference Page
↓
Family Migration
↓
Long-tail cleanup
```

### D0 · Preserve baseline and resolve authority

- 保留过去完成的 UI 对齐和当前用户/Agent 的未提交改动。
- 新视觉决策引用本文件；历史报告继续解释代码如何来到当前状态。
- 在 token 实施前保持 `--surface-*`、`--glass-*` 等旧名可用。
- 不修改原版布局来满足单一页面；不清理与任务无关的模块债务。

### D1 · Token bridge

先定义 semantic roles：canvas、content、boundary、accent、selection、input、overlay、dialog、state、motion、density。把 Web 与 Android 的现有 token 映射进同一命名/含义表，标出主题取值。把正文/metadata 下限纳入 token 方案。

加 alias 优先于 rename。避免一轮变更全部 CSS 和所有原始值。

### D2 · Primitives

先建立少量可复用原语：App Shell、page header、Section/Divider、List row、Interactive row、Form group、Inline status、Error disclosure、Popover、Dialog、Toast。默认原语应透明；明确 surface role 后才创建有边界容器。

每个原语需定义 L1/L2/L3、状态集合、Web/Android 交互目标、focus/reduced-motion 和 dark/light mapping。

### D3 · Home reference

Home Workspace 是首个 reference implementation。它验证 Navigation、主区宽度、content hierarchy、Quiet / Spatial / Alive / Personal、L1 status、Internal/Infernal 和 responsive rules。规范不因为 Home 的特例而调整。

欢迎页保留为单独 legacy/narrative surface，不强迫搬入 Home Workspace。先确定默认入口与 route 关系，再让 Home 打开在用户继续工作的内容上。

### D4 · Family migration

按此顺序逐家族进行，每次只处理明确范围：

1. **Chat**：会话列表、对话、角色 presence、typing、thinking、Voice 控件。
2. **Personal Space**：Blog、Letters、Moments、Favorites、Role DM、Diary、Cinema。
3. **System / Settings**：API、Credential Authority、Home Node、Diagnostics。
4. **Middle Brain**：与 API 的入口关系和 L1/L2/L3 配置层级。
5. **Memory**：内容浏览与系统设置拆清，保留有意义的数据星图。
6. **Voice**：调用/来电/同步等状态与 Chat 共用状态原语。
7. **Economy / Packaging**：复用 Dense layout、progress、result、approval、error disclosure。
8. **Mobile**：Web 窄屏和 Android 分别对照同一个 shell/state/depth contract。

### D5 · Long-tail cleanup

只有对应家族迁移时才移除重复 CSS、旧 surface 和无意义内联样式。筛查全局 Hero、玻璃层、raw 色值和未映射状态；带数据含义的图表/场景要保留语义证据，不按代码计数一概删除。

本轮完成冻结规范与 D0 路线定义，**停在 D；没有开始 E 的 Home 生产 UI 实现**。

## 22. Acceptance criteria

### Visual

- 普通页面首屏显示位置、当前状态、主要内容与一个明确下一步；无非必要 L3 内容。
- 每个有边界 Surface 都能说明语义拥有者；同一内容中不存在无语义嵌套 Card。
- 默认页面的结构在没有渐变、发光、阴影时仍然清楚。
- Light / Dark 共享结构、色彩语义、状态和控件含义；只有 token values 改变。
- Personal / System 的密度节奏不同，但品牌、导航、Typography、Spacing、Interaction 和 Surface 仍明显是同一个 IB。
- 字号、对比度、focus 与 touch target 达到本规范基线。

### Information

- 每个首屏的可见字段已标注 L1 / L2 / L3；L2、L3 只经明确动作打开。
- 普通首屏没有 endpoint、provider ID、credentialRef、model ID、latency、runtime、trace 或 raw error。
- 普通错误顺序是 human explanation → recovery action → collapsed technical details。
- Diagnostics 或显式 Technical Details 可给出完整、脱敏的 L3 context；Toast 不是唯一失败反馈。
- 状态文案、图标和颜色映射到统一的 state grammar。

### Architecture and responsive behavior

- 新页面可只依据此文件与通用 primitives 构建，不引用原版 DOM 或单页面特例。
- 新组件消费语义 token；不创建模块私有的颜色、半径、状态和 motion 系统。
- Desktop 与 Mobile 是同一信息/状态模型的不同布局；移动端不依赖 hover，不横向滚动阅读主要内容。
- Token/primitive 允许逐页迁移，不要求一次性重写。
- Existing legacy/narrative pages 有明确身份和边界，不会偶然成为业务页面默认模板。

## 23. Verification and audit limits

本阶段执行了只读检查：

- `git status --short --branch`、`git diff`、`git diff --cached`，确认已有工作树改动和空 staged diff。
- 检查导航、页面 route/初始 active 页面、Home Workspace、Chat、Memory、API/Middle Brain、Voice、Economy、Packaging、Diagnostics、Dialog/Toast、Web media rules、Android Compose theme。
- 对照现有 `docs/architecture/UI-SURFACE-AUTHORITY.md`、`NAVIGATION_ARCHITECTURE.md`、`HOME_WORKSPACE_AUDIT.md` 与 `docs/reports/UI-VISUAL-MIGRATION-AUDIT.md`。

未启动应用、未做浏览器截图、未运行自动化测试；第一屏结论来自源码结构和初始状态，不声称已经完成像素级视觉验收。本轮没有修改生产 HTML/CSS/JS/Android UI，也没有运行自动化测试。

---

## A–J closeout

- **A Existing Visual System Audit**：见 §19。
- **B Historical DNA**：见 §2。
- **C Visual Language v1**：见 §3–§5、§8–§14。
- **D Information Depth**：见 §6。
- **E Hard Constraints**：见 §6.1、§15、§18。
- **F Grammar**：见 §9–§13。
- **G Anti-patterns**：见 §18。
- **H Current Gap Map**：见 §20。
- **I Migration Order**：见 §21。
- **J Files / Verification**：规范文件本身与 shell authority note 已更新；无生产 UI 改动，验证边界见 §23。
