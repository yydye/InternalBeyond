# UI-P2 · Chat Image Deck / 聊天图片叠层

> 状态：**已实现，未提交**（`no commit / no push`，见 §51）。
> 基线 HEAD：`f80232a715b0c80a3fdbef89966d0f880c7d99f8`（UI-P1 Memory World 已 CLOSED）。

---

## 1. 这一阶段做什么

把「一条聊天消息里的多张图片」从**纵向平铺的普通附件**升级为克制、流畅、移动端友好的
**Image Deck（叠层）**：

| 数量 | 呈现 |
|---|---|
| 0 | `NO_IMAGE_DECK` —— 什么都不做 |
| 1 | `SINGLE_IMAGE` —— **完全不动**，保持今天的单图行为 |
| 2–6 | `STACKED_IMAGE_DECK` —— 当前图在前，后面最多 3 层 back card，横向 swipe / drag 切换 |
| >6 | `STACKED_IMAGE_DECK_WITH_EXPAND` —— 叠层不变，额外给一个明确的「展开 N」入口 |

**不是**：轮播大组件 / 图库管理器 / Pinterest 瀑布流 / 自动播放 / 3D 卡牌 /
Chat Runtime 重写。

---

## 2. 冻结契约

```
CHAT_IMAGE_DECK_READY           = YES
CHAT_IMAGE_PRESENTATION_POLICY   = 1_SINGLE / 2_TO_6_STACKED / GT_6_STACKED_WITH_EXPAND
IMAGE_DECK_ROLE                  = PRESENTATION_LAYER_ONLY
IMAGE_DECK_DATA_AUTHORITY        = MESSAGE_IMAGE_LIST（消息自带的 images 数组）
IMAGE_DECK_IMAGE_ORDER_AUTHORITY = EXISTING_MESSAGE_PAYLOAD_ORDER
IMAGE_DECK_DURABLE_WRITES        = 0
IMAGE_DECK_STATE_KEY             = data-msg-id  （= message.id）
IMAGE_DECK_NAVIGATION            = NON_LOOPING
IMAGE_DECK_GESTURE_ARBITRATION   = AXIS_INTENT_LOCK
IMAGE_DECK_PRELOAD_POLICY        = CURRENT_PLUS_NEXT
IMAGE_DECK_LAYOUT_SHIFT          = BOUNDED
IMAGE_VIEWER_DATA_AUTHORITY      = MESSAGE_IMAGE_LIST（复用既有 viewer，不建第二套）
VISIBLE_STACK_DEPTH              = 3        （>6 也最多 3 层后卡）
MESSAGE_SEMANTICS_CHANGED        = NO
VERTICAL_SCROLL_PRIORITY         = PRESERVED
MOBILE_GESTURE_ARBITRATION       = PASS
SINGLE_IMAGE_BEHAVIOR_CHANGED    = NO
```

---

## 3. 为什么是「渲染器之外」的实现（本节是这一阶段最重要的工程决定）

聊天消息图片由 `assets/js/communication.js` 追加，共 **4 处**：

| 位置 | 场景 |
|---|---|
| `communication.js:593` | 历史渲染 · 全屏 |
| `communication.js:619` | 历史渲染 · 小窗（额外写 `max-width:180px`） |
| `communication.js:3840` | 实时追加 · 全屏 |
| `communication.js:3868` | 实时追加 · 小窗 |

四处形状**完全一致**：在带 `data-msg-id` 的消息行里，连续 append 若干
`<img class="chat-bubble-img">`（`{dataUrl,base64,mime,name}`，`IMG_MAX_COUNT=6`）。

而 `communication.js` 在本阶段开始时已是**用户 dirty** 文件。按 UI-P2 §47，因此
**不修改它**，改由 `assets/js/chat-image-deck.js` 在渲染器之外观察两个容器：

```
#chat-full-messages   (InternalBeyond.html:352)   全屏对话
#chat-messages        (InternalBeyond.html:3276)  小窗面板
```

发现「一条消息里连续 ≥2 张图片」就把这一段重新组合成 deck。三条硬性好处：

1. **消息管线一个字节都没动** —— `MESSAGE_SEMANTICS_CHANGED = NO` 是结构上成立的，
   不是靠自觉；
2. **保住产品自己的点击链路** —— 被搬进 deck 的是**原 `<img>` 元素本身**（不是克隆），
   它的 `onclick = function(){_viewImageFull(img.dataUrl, img)}` 与 `src`、
   `loading`/`decoding` 全部原样保留，于是既有 viewer 与「编辑这张图」入口都还在；
3. **不复制图片** —— 不重新 fetch、不重新编码、不复制 blob、不建第二份 image authority。

### 3.1 之所以能用这个接缝（隔离性）

- 只认 **`.chat-msg > img.chat-bubble-img`**（直接子元素）且必须是**连续兄弟段**。
  ICode 运行卡里的 `<img class="chat-bubble-img">` 嵌在 `.ws-op-detail` 里
  （`workspace.js:702-705`）且外层没有 `data-msg-id`，因此**不会被误收**。
- 没有稳定身份（`data-msg-id` 为空，例如流式进行中的气泡
  `communication.js:6529`）的行**不做 deck**，保持既有呈现 —— 这条同时保证了
  §32 的「状态必须绑稳定 message id」。

### 3.2 幂等与重入（§31 / §44）

`_renderAllChat` 以 `container.innerHTML=''` 整段重建（`communication.js:664`），
`_chatWithdrawMsg`（`:5887-5890`）会删掉再建同 `data-msg-id` 的节点，
`_chatWinMore` 还会**前插**分片。所以 deck 必须可重入：

- 每条消息只在 `rec.adopted` 未置位时接管 DOM，置位发生在**DOM 手术成功之后**；
- 行被重建后旧 DOM 消失 → `forget(msgId)` → 用新图片重新接管；
- **`currentIndex` 保留**，只有「新数组更短」时才被 clamp —— 这正是 §31 允许的唯一情形。

---

## 4. 视觉模型（§8 / §9 / §28）

- 当前图为 front card；后面**最多 3 层** back card，逐层 `translateX/Y` + `scale` 递减
  （`1 → 0.965 → 0.93 → 0.897`）、`opacity` 递减（`1 → 0.92 → 0.8 → 0.66`）、
  `rotate` 最多 `0.9deg`。
- **没有** 10deg 旋转、没有弹飞、没有 3D perspective、没有弹簧。
- 后卡 `pointer-events:none` —— 只有当前图可被点开，点与拖不会有歧义。
- 只动 `transform` / `opacity`，不动布局属性；时长落在
  `--ib-token-motion-state`（180–200ms 量级），`prefers-reduced-motion` 下
  `transition: none`。
- deck 本身**没有面板底、没有描边、没有卡片套卡片、没有控制条**：图片是主体。

## 5. 手势裁决（§10–§12 / §19）—— 本阶段硬门

```
IMAGE_DECK_GESTURE_ARBITRATION = AXIS_INTENT_LOCK
```

1. **`pointerdown` 绝不 `preventDefault`** —— 纵向滚动必须能立刻接管。
2. `pointermove` 里先判**轴意图**，`|dx| > |dy| × 1.25` 才锁定为 deck；
   `|dy|` 胜出则**立即退回**，deck 全程不介入。
3. CSS `touch-action: pan-y` —— 纵向由浏览器原生滚动，横向留给 deck。
4. **左缘安全区**：`pointerdown` 的 `clientX <= 24px` 直接不启动 drag，
   把系统返回手势（Android WebView / 浏览器 edge-back）让出去。
5. 提交阈值是**相对量**：`|dx| > width × 0.22` 或速度 `> 0.5 px/ms`；
   不达标回弹。
6. **click vs drag**：位移超过 6px 就记 `suppressClick`（350ms），
   捕获阶段拦掉紧随其后的 `click` —— 不会出现「刚 swipe 完 viewer 又打开」。

## 6. 布局稳定 / 加载 / 错误（§20–§24）

- 帧比例由**第一张图**的比例定一次（clamp 到 `0.62–2.35`），此后切图不再改变高度
  → `IMAGE_DECK_LAYOUT_SHIFT = BOUNDED`；图片未就绪时保留默认帧，**不会塌成 0 高**。
- 卡内图片 `object-fit: contain`，极端比例不裁关键信息。
- **预载策略**：当前图 + 下一张 `loading="eager"`，其余保持 `lazy`；
  更关键的是超出可见叠层的卡被 `display:none`，浏览器因此**根本不会去 decode 它们**
  → 20 张也不会一次全解码。
- 单张加载失败**只影响该 index**：deck 不消失、卡片不减少、仍可切到下一张。

## 7. 可访问性 / 键盘（§25 / §26）

- deck 可聚焦（`tabindex=0`），`role="group"`，`aria-label="图片 n / N"`；
- `role="status" aria-live="polite"` 播报切图；
- 上/下一张按钮有 `aria-label`，越界时 `disabled`（NON_LOOPING 的可感知表达）；
- 「展开 N」写成 **`展开 <总数>`**（不是含义不清的 `+N`），`aria-haspopup="dialog"`；
- `keydown` **只挂在 deck 自己身上**：`ArrowLeft` / `ArrowRight` / `Enter` / `Space`。
  **没有 document 级键盘监听**，不劫持聊天快捷键；
- 隐藏的后卡不进 tab 序列。

## 8. >6 的展开（§16 / §17 / §18）

「展开 N」打开一个**最小 gallery 网格**（`role="dialog" aria-modal`，ESC / 背景 / × 关闭，
关闭后焦点回到触发按钮）。网格里每一张仍然交回既有 viewer，
**没有第二套 fullscreen viewer**。网格图片以同一 `src` 引用并 `loading="lazy"`，
不复制 blob。

## 9. 与既有 viewer 的关系（§36 / §37）

```
EXISTING_IMAGE_VIEWER = YES（communication.js:1466 _viewImageFull，导出 window._viewImageFull:7204）
  single  YES · close(点击任意处) YES · multi NO · keyboard NO · swipe NO · zoom NO · download NO
```

本阶段**只补缺失部分**：deck 的打开、上一张/下一张、以及 >6 的最小 gallery。
不新增 crop / edit / annotate / AI enhance。`_viewImageFull` 一行未改。

## 10. 数据与安全（§33 / §34 / §35）

- `currentIndex` 只存在模块内的 `Map`（session-local），
  **零** `dbPut/dbDelete/dbUpdate/localStorage/sessionStorage/indexedDB/fetch(`；
- 不改 `content` / `images` / URL / caption / sender / timestamp / role / thread；
- **不新增 `innerHTML`**（`_viewImageFull` 里既有的字符串拼接没有被我沿用或扩散）；
  图片一律走 `createElement` + `.src`（dataUrl），沿用既有安全边界；
- 唯一对产品元素的写操作是：把图片**搬进** deck、清掉 renderer 写在元素上的内联
  `max-width/max-height`（内联样式会压过任何选择器，不让位就无法按帧叠放）、
  以及置 `draggable=false`（否则桌面鼠标拖动会被原生图片拖拽抢走）。
  这三项都是呈现层，不是 message 语义。

## 11. 群聊隔离（§30）

状态按 `data-msg-id` 分桶，每条消息一个 record，各自持有 `index` / `drag` / `suppressClick`。
两个 deck 同时存在时互不影响（浏览器套件有专门断言）。

## 12. 已知边界（诚实记录）

- **群聊图片路径（精确冻结 · UI-P2.1b §17）**
  ```
  GROUP_LIVE_IMAGE_APPEND_SUPPORT   = PREEXISTING_NOT_SUPPORTED
  GROUP_RENDER_ALL_EXISTING_IMAGES  = DECK_ENHANCED
  ALL_GROUP_IMAGE_PATHS_SUPPORTED   = NO    ← 不得声称已全部支持
  ```
  机械依据：
  - `communication.js:3022` 群聊 AI 消息**确实**把生成的图片写库
    （`aiMsg.images = _wsCollectGenImages(_gwsR)` 之后才 `dbPut`）；
  - 但 `communication.js:3047` 的**实时追加**把第 6 个参数（images）传成了
    `undefined`：`appendChatBubble('ai',reply,selfName,groupThinking||undefined,aiMsg.id,undefined,…)`。
    对照单聊非流式 `communication.js:3711` 传的是 `aiMsg.images`。
    因此「刚生成的图」在群聊里要等一次重渲染才出现 —— 这是**既有渲染器行为**，
    位于用户 dirty 文件内，UI-P2 **不修**。
  - 重渲染走共享路径 `_renderAllChat → _chatWinMsgEl → _buildMsgEl`，多图追加点即
    `_buildMsgEl:593`；deck 只认「带 `data-msg-id` 的行 + ≥2 张连续直接子图片」，
    所以**已有多图在重渲染时会被 Deck 增强**（DECK_ENHANCED）。该结论依据的是
    共享渲染器路径（浏览器套件覆盖的正是 `:593`），不是跑通的真实群聊回合。
- 页面切换是异步的（`.page` → `.page.active`）：`#page-chat` 不是 `active` 时整页
  `display:none`，此时任何几何断言都会读到 0。测试侧必须显式等待激活
  （见 `tests/test_chat_image_deck_browser.js` 的 `ensureChatSurface`）。
- 展示对象的 `preloader.js` 加载接缝是本阶段唯一被修改的既有文件（+17 行，
  纯新增 IIFE，注释说明用途）。

## 13. 清单（EXACT UI_P2 MANIFEST）

| 路径 | 类别 |
|---|---|
| `assets/js/chat-image-deck.js` | NEW（BOM · LF） |
| `assets/css/chat-image-deck.css` | NEW（BOM · LF · guardrail KPI 0/8） |
| `tests/test_chat_image_deck.js` | NEW（结构，纯 Node） |
| `tests/test_chat_image_deck_browser.js` | NEW（真实 Chrome E2E） |
| `docs/architecture/UI_P2_CHAT_IMAGE_DECK.md` | NEW（本文件） |
| `assets/js/preloader.js` | HEAD_CLEAN_PLUS_AUTHORIZED_HUNK（+17 / -0，1 hunk） |
| `tests/test-all.js` | HEAD_CLEAN_PLUS_AUTHORIZED_HUNK（+9 / -0，1 hunk） |

```
TOTAL = 7 · EXTRA = 0 · MISSING = 0 · UNKNOWN = 0
USER_DIRTY_INCLUDED_IN_CANDIDATE = NO
```
