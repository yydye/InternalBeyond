# UI-P1 / UI-P1.1 · Memory World / 记忆世界

- 状态：**UI-P1 已实现并验证；UI-P1.1 视觉重构已实现并验证**
- 范围：Memory 的**表现层**。不是 Memory Runtime 重设计。
- 基线：`HEAD = a5418d52fc4e4a34c4b3868d068a1eaca88c175a`
  （`R4_MAIN_COGNITIVE_LOOP = CLOSED`、`R4_PRODUCTIZATION = COMPLETE`）
- 生产文件：
  - `assets/js/memory-world.js`（新，运行时由 mount seam 注入）
  - `assets/css/memory-world.css`（新，运行时由模块注入）
  - `assets/js/memory-sky.js`（干净文件，只加了一段 loader）
  - `tests/{test_memory_world_browser,test_memory_world_side_effects,test_memory_world_layout,test_memory_world_visual_contract}.js`（新）
  - `tests/helpers/memory-world-cdp.js`（新）
  - `tests/test-all.js`（登记四条新套件）

> **UI-P1.1 增补（Memory Rift / 记忆断层）**：视觉重构层。§2–§13 描述的
> 角色、数据权威、映射、确定性布局、零副作用与 candidate 纪律**全部不变**；
> 变化只在「世界长什么样」和「chrome 有多少」。见本文末尾 §17。

## 1. 冻结的角色与边界

```
MEMORY_WORLD_ROLE               = PRESENTATION_LAYER_ONLY
MEMORY_WORLD_DATA_AUTHORITY     = window.dbGetAll('memories')   ← 既有唯一读路径
MEMORY_WORLD_DURABLE_WRITES     = 0
MEMORY_WORLD_ASSOCIATION_LINES  = DISABLED
POSITION_HAS_SEMANTIC_AUTHORITY = NO
COGNITIVE_PRIVATE_STATE_EXPOSURE= NONE
REFERENCE_INSPIRATION           = CONCEPT_ONLY
DIRECT_VISUAL_COPY              = NO
MEMORY_WORLD_REPLACES_MEMORY_LIBRARY = NO
```

不改变：`memory_records` / canonical memory / activation / importance / visibility /
Recall selection / Recall score / MetaMemory / Interpretation / Expectation /
BehaviorEffect / relationship / persona / speech_style / tool policy。

不写回的理由不是「没调用」，而是**结构上不可达**：模块源码里没有
`dbPut` / `dbDelete` / `dbUpdate` / `recordMemoryActivation` / `getMemoryContext` /
`_reconcileReferences` / `localStorage` / `indexedDB` / `fetch(` 的任何出现
（`tests/test_memory_world_side_effects.js` §1 逐符号断言，注释先被剥离）。

## 2. 数据事实 → 视觉通道（冻结映射）

只使用确实存在且稳定的字段（见 `docs/contracts/memory/MEMORY_RECORD_CONTRACT.md`
与 `assets/js/memory.js` 的写入端）：

| 视觉通道 | 来源 | 性质 |
|---|---|---|
| 节点大小 | `importance`（1–10，写入端 clamp） | 真实、稳定、可编辑 |
| 节点亮度 | `window.getMemVitality(m)`（既有的**表现层派生**原语：pinned / lastActivated / resolved / activationCount） | 派生值，不作为数字展示，只作视觉权重 |
| 节点色偏 | `window.MEM_DOMAIN_COLORS[domain]`（单源），再向主题强调色收拢 45% | 真实字段 + 既有色板；不新增品牌色、不引入紫色 |
| 置顶标记 | `pinned` → 细环（**形状**线索，非颜色） | 真实、稳定 |
| 选中标记 | 双环 + 四向刻度（形状线索） | 交互状态 |
| 位置 | `memory.id` 的确定性散列 | **纯视觉**，无语义权威 |

明确不用：`category`（全仓只有一个写者）、`source`（写者会把值落到 `rawSource`）、
`updatedAt`（memories 上不存在）、`revision`（服务端列，浏览器无读者）、
`characterId`（单写者、不在契约里）、`visibilityRepairedAt/Reason`（稀疏审计戳）。

防御：`title/summary/content` 可能是 `null` 或数字；`created` 可能缺失（旧导入只用
`createdAt`）；`valence` 可能是字符串。模块逐条 `normalize`，缺字段走默认值，
不合法记录被跳过而不是让世界报错（`test_memory_world_layout.js` §5 有反例）。

## 3. 不发明 Association

当前没有 live Association authority，所以世界内**不画任何连接两个记忆节点的线**。
静态守卫断言源码里没有 `<line` / `createElementNS`，并断言模块自报
`associationLines: 'DISABLED'`。环境层只有横向沉积带与微尘 —— 它们不连接任何
两个 memory，也不暗示语义接近。

## 4. 确定性布局

```
x = hash(memory.id + '~layout-x') / 2^32
y = hash(memory.id + '~layout-y') / 2^32
→ 3 轮确定性分离（图格邻居推挤，无随机数，按 id 稳定排序处理）
```

- `hash32` = FNV-1a + 雪崩终结。**首轮原型暴露过**：只做 FNV 时相邻 id 会退化到一条
  斜线上（两通道高度相关），所以必须补终结混合。
- 位置只依赖 `id`：正序 / 逆序输入结果逐点相同；模块重读与真实页面重载后
  fingerprint 一致；不同 id 集合 fingerprint 不同。
- 不持久化节点位置到 memory record；第一版不支持拖动。

## 5. 架构裁决：Canvas（单画布 + 精灵）

| 维度 | Canvas 2D | SVG | 每 memory 一个 DOM |
|---|---|---|---|
| 200 / 500 / 1000 条 | 1.6 / 2.6 / 4.8 ms 绘制 | 1000 个 `<circle>` 的样式/命中开销更大 | 1000 张卡 → 明确出局 |
| 命中测试 | 均匀网格 + 最近点（我们自建 hit 表） | 原生命中 | 原生 |
| 可访问性 | 画布本身不可逐节点可达 → 必须补 DOM 路径 | 可通过 ARIA 逐节点可达 | 天然可达 |
| 主题 | 运行时从语义 token 解析颜色 | 同 | 同 |
| 移动端 | 单画布 + 无拖拽手势，不抢 back/scroll | 同 | 同 |
| 现有依赖 | 零新增（`memory-sky.js` 已是 canvas 2D 先例） | 零新增 | 零新增 |

裁决：**Canvas 2D**。代价是逐节点不可达，因此补一条 DOM 可访问路径（§8）。
不引入任何图形框架。

## 6. 规模与性能（实测）

| 条数 | reload→ready | 节点绘制 | 渲染节点 | 世界内 DOM 节点 | 可交互 |
|---:|---:|---:|---:|---:|---|
| 200 | ~51–57 ms | 1.6 ms | 200 / 200 | 27 | 是 |
| 500 | ~78–90 ms | 2.6 ms | 500 / 500 | 27 | 是 |
| 1000 | ~110–125 ms | 4.8 ms | 1000 / 1000 | 27 | 是 |

- **不做 sampling**：任何条数都完整渲染（`renderedNodes === items`）。所以不存在
  「没显示的 memory 看起来不存在」这个问题 —— 它被设计上排除，而不是被声明排除。
- 世界本身不是每 memory 一张 DOM 卡：DOM 节点数与条数无关（27）。
- 空闲时**没有 rAF 循环**；只有环境层一条 108s 的 CSS transform 漂移，
  节点是完全静态的（没有 per-node 无限脉动）。
- 实测环境：本机 headless Chrome，Windows；数字用于回归比较，不声称是专业基准。

## 7. Light / Dark 是两个世界

同一个数据布局，两套环境渲染，**不是反色**：

- **Internal（light）**：晨雾。顶部近白、底部淡灰蓝，断层带为浅冷灰蓝，
  记忆是**墨色实点 + 浅色缘**（材质感）。
- **Infernal（dark）**：深潜。顶部微亮、底部更深，断层带为青冷微光，
  记忆是**冷光核 + 晕**（发光感）。

取证不是肉眼结论：浏览器套件用 `getImageData` 计算入口环境层的平均通道值，
断言 `dark < light - 20`（实测 light≈228 / dark≈40）。

## 8. 可访问性

画布对辅助技术不可逐节点可达，因此：

- 画布 `aria-hidden="true"`；世界是 `role="dialog"` + `aria-modal="true"` + `aria-label`。
- **查找面板**（同一份 `state.items`，不是第二份 authority）：搜索框 + `role="listbox"`
  行（`role="option"` + `aria-selected`），支持 ↑/↓/Enter，键盘完全可达。
  截断是**明示**的：「匹配 N 条 · 显示前 60 条（其余在 Memory 列表里）」。
- 选中结果通过 `role="status" aria-live="polite"` 播报。
- 置顶 / 选中用**形状**（环、刻度）表达，不依赖颜色。
- 键盘：`Esc` 退出（含 `Tab` 焦点环与打开既有弹窗时让位）；触控目标 ≥ 44×44。
- 不改任何 memory 语义，也不复制编辑器：`打开记忆` → 既有 `openMemoryModal(id)`。

## 9. 导航

- 入口是真正的 `<button aria-haspopup="dialog" aria-controls=...>`。
- 世界是页内全屏 overlay，不是新路由：打开时 `history.pushState`（**URL 不变**），
  `popstate` 关闭 → 浏览器后退与 `Esc` / 退出按钮行为一致；`hashchange`（用户从
  导航离开 Memory）也会关闭它。不制造秘密 page state。
- 焦点：打开后进入对话框，关闭后回到触发元素（程序化打开时退回入口）。

## 10. 环境层运动（有界、可关、后台停）

- **只有环境层**在动：一条 `transform` 漂移，108s，`alternate`；节点完全静态。
- `prefers-reduced-motion: reduce` → CSS 动画 `none`，JS 同步把 `data-motion` 置 `off`。
- 页面隐藏（`visibilitychange`）→ `data-paused="true"`，环境层暂停。
- 世界内有一个 `环境运动` 开关（`aria-pressed` + 空心/实心圆形状线索），可随时关掉。
- 这条环境运动是本阶段用户简报明确允许的「缓慢环境运动（雾 / 微光 / 漂移 / 潮汐感）」；
  它与冻结规范 §13/§18 里禁止的「装饰性粒子 / 无止境循环」的边界是：
  **只有一层、只在环境、无数据含义、可关、后台停、reduced-motion 静态**。

## 11. 与参考截图的距离

`REFERENCE_INSPIRATION = CONCEPT_ONLY`，`DIRECT_VISUAL_COPY = NO`：

不使用 Nameless Coastline 命名 / `wade in` 文案 / 岸线轮廓 / 泡沫线 / 暖沙色 /
斜向波带 / 相同星形集合 / 相同配置面板布局。IB 自己的语言是**垂直深度分层**
（横向沉积带 = 断层）而不是一条斜向海岸线；入口的文案层级是
`Memory World / 记忆世界 / N 条记忆 / 一句说明 / 进入`，与参考的
「左下斜体标题 + 右下 wade in」不同。

## 12. 保留既有管理面

`MEMORY_WORLD_REPLACES_MEMORY_LIBRARY = NO`。搜索 / 筛选 / 排序 / 卡片 / 时间轴 /
编辑 / 删除 / 导入导出 / 星图 / 指标盘 / 引用横幅全部原样保留；Memory World 是
**加法**：`#page-memory` 的 `.module-intro` 之后插入一个入口，选中后交回既有
detail/edit authority。没有调用 `renderMemories` / `updateMemDashboard`
（它们拥有 `#mem-list` 与星图/指标盘 DOM）。

## 13. Candidate 纪律

`UI_P1_MANIFEST` = 上面 §1 列出的 8 个文件。其中：

- `assets/js/memory-world.js`、`assets/css/memory-world.css`、三条测试、helper、
  本文档 = **新增文件**。
- `assets/js/memory-sky.js`、`tests/test-all.js` = **HEAD 干净文件 + 单一 authorized hunk**。

**没有修改任何 user dirty 文件**（`REQUIRED_DIRTY_OWNER_PATHS = {}`）。因此
`candidate = HEAD + EXACT UI_P1 MANIFEST`，不存在 dirty subtraction，
也没有把整个 dirty blob 带进 candidate。

代价与理由：`InternalBeyond.html` 是 user dirty 文件，且
`tests/test_frontend_structure.js:98` 把样式表数量**精确**冻结为 25 —— 直接加
`<link>` 或 `<script>` 会同时触发结构断言与 guardrail。
因此沿用仓库自己的两种既有约定：

1. 样式表**运行时注入**（`update-card.js` / `setup-wizard.js` / `diagnostics.js` /
   `api-onboarding.js` / `guide.js` / `economy-approval.css` 都是这么做，
   `test-all.js:1862` 明确记为「运行时注入，不占 HTML 的样式表预算」）；
2. 脚本由**干净的、已加载的** `memory-sky.js` 动态注入
   （`communication.js:2114-2133`、`app-store.js:45-51` 的既有 loader 模式）。

## 14. 验证记录

- `tests/test_memory_world_browser.js` — 51 断言（入口 / 0 / 1 / 200 条 /
  真实指针命中选中 / 打开既有 detail / Esc + 浏览器后退退出 / light↔dark 像素差异 /
  390px / reduced-motion / 无横向溢出 / 无未捕获异常）。
- `tests/test_memory_world_side_effects.js` — 37 断言（静态写面 + 运行期
  `MEMORY_WORLD_DURABLE_WRITES = 0` / `recordMemoryActivation = 0`）。
- `tests/test_memory_world_layout.js` — 35 断言（确定性 + 分布 + 200/500/1000 规模）。
- 三条套件已登记进 `tests/test-all.js` 的 `browser` 组。
- 视觉取证：见本阶段报告 §V（desktop light/dark、390px light/dark 实拍）。

回归对照（`HEAD` 归档树 vs `HEAD + UI_P1 MANIFEST` 树）：
`test_frontend_structure` 12/12 相同失败、`test_ui_regression` 4/4 相同失败、
其余 8 条套件两棵树都全绿 → **NEW_FAILURES = 0**。
`scripts/ui-guardrail.js check` 在两棵树上给出**同一组 10 条**回归
（都是别的并行工作线新增文件的 BOM 债），本模块**没有**任何
`kpi NEW FILE assets/css/memory-world.css` 项。

## 15. 对 D1 token 层的依赖（实跑发现，已处理）

Memory World 消费 `--ib-token-*`（IB Visual Token Contract v1 的语义 API）。但
**该 token 桥接本身属于另一条并行工作线的未提交改动**（`assets/css/core.css` 的
D1 段落）。在 `HEAD + UI_P1 MANIFEST` 的候选树上它并不存在，于是：

- CSS 侧所有 `var(--ib-token-*)` 都变成未声明 → padding/radius/z-index 塌成初始值；
- JS 侧更隐蔽：把 `color` 设成未声明角色会静默变成 `inherit`，`getComputedStyle`
  仍然解析成功，于是拿到的其实是**继承来的正文色**（表现为 light/dark 亮度反转）。

处理方式（不是绕过，是补上契约本来就规定的兼容路径）：

1. `memory-world.css` 的每一处 `--ib-token-*` 都写成
   `var(--ib-token-x, var(--legacy-y))` —— IB Visual Token Contract v1 §5 的
   alias-first 策略；token 层在场时语义角色优先，缺席时退回它桥接的既有原语。
2. `memory-world.js` 的取色改为 `roleColor(role, legacyLight, legacyDark, fallback)`，
   先用 `getPropertyValue(role)` 判空，再回退到既有原语，最后才是硬编码兜底。

结果：模块在**两代树**上都成立（候选树 51/37/35 全绿，且 light/dark 极性正确）。
这条依赖关系如实记录，不做隐藏：本模块需要 D1 token 层才能呈现在产品里，
而该层已经在当前工作树中。

## 16. Candidate

```
UI_P1_MANIFEST（10 个文件 · UI-P1.1 后）
  NEW .................. assets/js/memory-world.js
                         assets/css/memory-world.css
                         tests/helpers/memory-world-cdp.js
                         tests/test_memory_world_browser.js
                         tests/test_memory_world_side_effects.js
                         tests/test_memory_world_layout.js
                         tests/test_memory_world_visual_contract.js   ← UI-P1.1
                         docs/architecture/UI_P1_MEMORY_WORLD.md
  HEAD-clean + hunk .... assets/js/memory-sky.js   (+17 行 loader，1 hunk)
                         tests/test-all.js         (+17 行登记，1 hunk)
EXTRA = 0 · MISSING = 0 · UNKNOWN = 0
REQUIRED_DIRTY_OWNER_PATHS = {}
```

---

# UI-P1.1 · Memory Rift / 记忆断层（视觉重构）

## 17. 视觉重构（覆盖 §6–§13 的视觉部分；语义部分一字不动）

### 17.1 诊断（v1 冻结的失败）

```
CURRENT_VISUAL_FAILURES = [
  FLAT_SCATTER_PLOT_FEEL, NO_MACRO_FORM, INSUFFICIENT_DEPTH,
  NODES_TOO_EQUAL, LIGHT_THEME_HAS_NO_MATERIAL,
  UI_CHROME_TOO_TOOL_LIKE, MEMORY_PAGE_HAS_TWO_COMPETING_STAR_FIELDS ]
```

### 17.2 宏观断层（Macro Composition）

```
MACRO_ENVIRONMENT_BANDS          = 2
RIFT_BANDS_HAVE_MEMORY_SEMANTICS = NO
ENVIRONMENT_LAYOUT_DETERMINISTIC = YES
```

- 两条断层定义在**归一化世界坐标 [0,1]²**：
  `y = base + a₁·sin(2π(f₁x+p₁)) + a₂·sin(2π(f₂x+p₂))`，
  再叠确定性平滑噪声（哈希插值）给出厚薄与脊亮度。
- 主断层从左上方进入 → 向中部下沉 → 向右延伸；第二条在下方形成第二层空间关系。
- 有断裂（段内平滑消失）、雾、光晕、颗粒聚集、局部厚薄变化。
- 渲染 = 多遍描边「外晕 → 体 → 亮脊」，脊亮度沿 x 由噪声调制（亮核 / 化雾交替）。
  刻意**不用** `ctx.filter` 模糊：整幅画布做 blur 的代价不可控，分段描边是线性的。
- **纵横比只是拉伸同一个世界**：竖屏把同一条曲线拉陡，于是移动端天然获得
  纵向贯穿的宏观结构，而不是把桌面裁窄。

> **断层只是 presentation geometry。** 它**不是** association、**不是** timeline、
> **不是** causal relation，**也不是** memory cluster authority：
> 它不连接任何两个 memory 节点，不按 text similarity / domain / distance / tag /
> importance 生成任何语义连线，也不表示记忆之间"更近"或"相关"。
> 同一句话写在代码注释（`MACRO_ENVIRONMENT_BANDS` / `RIFT_BANDS_HAVE_MEMORY_SEMANTICS`）
> 与本文档两处，未来开发者与使用者都不得把它读成语义结构。

### 17.3 深度（三层）

| 层 | 内容 | 手段 |
|---|---|---|
| BACKGROUND | 极暗大面积 + 远尘 | 底部洗色 + 稀疏微尘（独立画布，反向慢漂） |
| MIDGROUND | 断层 / 雾 / 潮流 | 断层体多遍描边、沿线雾团、颗粒聚集 |
| FOREGROUND | 少数 anchor + selection | 排名 top 2% 提亮、晕更大、带极淡衍射十字 |

节点另有一条独立的确定性「深度平面」（`unit(id,'depth')`）：
55% background（alpha ×0.58、无光晕、以柔斑替核心）、33% midground、
12% foreground（alpha ×1.14）。另有**局部雾遮蔽**：位于断层雾体内的节点被压暗，
**下限 0.62** —— 只做纵深，不做隐藏。

### 17.4 节点视觉分层（压缩映射）

```
score = importance/10 * 0.50 + vitality * 0.40 + (pinned ? 0.10 : 0)
→ 按 (score desc, id asc) 排名分位：
   2% anchor · 8% strong · 20% light · 70% speck
```

按**分位数**而非固定阈值：无论数据分布如何，画面都不会退化成一屏同强度光点。
200 条实测 `{anchor:4, strong:16, light:40, speck:140}`。
**所有 memory 仍然全部渲染**（`renderedNodes === items`，永不 sampling）——
分层只改视觉权重，不改存在性。

### 17.5 材质

- **Dark（主视觉）**：深蓝黑大面积黑场；断层为青冷光脊，脊上叠**极少量淡暖**
  （取自既有语义角色 `--ib-token-status-warning`；不新增品牌色、不引入紫色）。
- **Light（Frost / Pale Rift）**：不是反相 —— 底部洗色 + 断层雾体 + **纸纤维颗粒**
  （确定性短划）= 冰雾 / 纸纤维 / 浅水雾；脊是略深的冷灰蓝线；节点是**淡墨晶点 + 浅色缘**。

```
LIGHT_WORLD_IS_DARK_INVERSION = NO
```

### 17.6 入口 / chrome / finder / preview

- **入口 = WORLD WINDOW**：无边框、无圆角、无卡片阴影；「窗」的四边由画布自己用
  `destination-out` 溶解。标题移到**顶部窗牌**（不再占左下 Hero 位），
  `进入世界 →` 是低 chrome 文字动作。
- **全屏 chrome**：满幅世界 + 浮在顶部的两组字；`WORLD_OCCUPIES_VISUAL_ATTENTION >= 90%`。
  常驻只有 `···`（次要菜单）与 `×`（退出）；**查找 / 环境运动 收进菜单**。
- **Finder = command palette**：默认完全隐藏；打开后是窄（≤520px）、居中偏上、
  低 chrome 的浮层，仍用同一份 `state.items`（不是第二 authority）。
- **Preview = annotation**：无面板底、无边框（实测 `backgroundColor: rgba(0,0,0,0)`、
  `borderTop/Left/Right: 0px`），可读性由文字自身光晕承担，只保留动作上方一条发丝线。
  仍保留 date / domain / importance / resolved / title / summary / 打开记忆。

### 17.7 星图共存

```
STAR_MAP_COEXISTENCE_DECISION = C+B（Memory World 单独使用时迁入 Library 段 + 默认折叠；原版 Coastline/Fathom 共用时移至共享视图位 + 默认展开）
```

审计结论：既有星图是 **ambient 数据视图、没有任何交互** —— 点星只冒一下火花，
不导航、不打开记忆（`memory/constellations.js:65-70`）。它却紧贴 Memory World
入口下方，形成两个互相竞争的视觉场。

处理：没有原版 Coastline 控件时，模块挂载把它（连同 legend）移入 Library 末尾的
`<details>` 折叠项（`星图 · Star Map`），默认收起。存在 Coastline 控件时，折叠项
移到共享仪表盘之前并默认展开，使 Library 与 Fathom 共用同一星图和 legend。**功能一个不删**：
同样的 id、同样的 `buildMemorySky`、同样的 legend；折叠项展开即用（canvas 由 ResizeObserver
在尺寸出现时重建）。
`test_memory_smoke.js` 的星座断言针对自建 SVG，不受影响。

### 17.8 运动

只剩**两张环境画布的反向慢漂移**（108s / 166s）→ 视差纵深；
**memory 节点完全静止**，没有 per-node 脉动。
`prefers-reduced-motion` 下两条动画都 `none`，模块同时置 `data-motion="off"`；
页面隐藏时 `data-paused` 暂停。

### 17.9 UI-P1.1 delta（都在 UI_P1_MANIFEST 之内，不新增文件范围）

| 文件 | UI-P1.1 变化 |
|---|---|
| `assets/js/memory-world.js` | 断层/雾/纤维渲染、节点分层、入口 caption、`···` 菜单、command palette、annotation preview、星图折叠 |
| `assets/css/memory-world.css` | WORLD WINDOW、满幅世界 + 极简 chrome、两层环境画布与两条漂移、annotation preview、command palette、星图折叠 |
| `tests/test_memory_world_visual_contract.js` | **新增**（41 断言，几何/契约，不是像素 golden） |
| `tests/test_memory_world_browser.js` | 仅按新 chrome 结构改触控目标断言（**未放宽任何 a11y / authority 语义**） |
| `tests/test-all.js` | 多登记一条套件 |

`EXTRA = 0 · MISSING = 0 · UNKNOWN = 0` 不变。

---

## 18. UI-P1.2 · 闭包契约（冻结）

本节是 UI-P1 系列的最终冻结值。以下每一项都由本阶段的机械检查或测试套件证明，
不再包含任何视觉改动。

```
MEMORY_WORLD_READY                    = YES
MEMORY_WORLD_VISUAL_RECOMPOSITION     = PASS

MEMORY_WORLD_ROLE                     = PRESENTATION_LAYER_ONLY
MEMORY_WORLD_DATA_AUTHORITY           = EXISTING_MEMORY_READ_PATH
MEMORY_WORLD_DURABLE_WRITES           = 0
MEMORY_WORLD_ASSOCIATION_LINES        = DISABLED
POSITION_HAS_SEMANTIC_AUTHORITY       = NO
COGNITIVE_PRIVATE_STATE_EXPOSURE      = NONE

MEMORY_WORLD_MACRO_STRUCTURE          = YES   (MACRO_ENVIRONMENT_BANDS = 2)
MEMORY_WORLD_DEPTH_LAYERS             = YES   (background / midground / foreground)
MEMORY_WORLD_NODE_HIERARCHY           = YES   (anchor 2% / strong 8% / light 20% / speck 70%)

LIGHT_WORLD_HAS_INDEPENDENT_MATERIAL  = YES
LIGHT_WORLD_IS_DARK_INVERSION         = NO

RIFT_BANDS_HAVE_MEMORY_SEMANTICS      = NO
ENVIRONMENT_LAYOUT_DETERMINISTIC      = YES

STAR_MAP_COEXISTENCE_DECISION         = C+B
MEMORY_WORLD_REPLACES_MEMORY_LIBRARY  = NO

UNKNOWN_FILES                         = 0
USER_DIRTY_FILES_IN_MANIFEST          = 0
USER_DIRTY_INCLUDED_IN_CANDIDATE      = NO
CANDIDATE_LEAKS_NON_MANIFEST          = 0
```

### 18.1 只读面（机械证明）

`memory-world.js` 的注释剥离后，以下标识出现次数**全部为 0**：
`dbPut` / `dbDelete` / `dbUpdate` / `recordMemoryActivation` / `getMemoryContext` /
`selectMemoryContext` / `saveMemory` / `toggleMemPin` / `toggleMemResolved` /
`deleteMemory` / `localStorage` / `indexedDB` / `sessionStorage` / `fetch(`。
唯一读路径是 `window.dbGetAll('memories')`；不新建 store、不新建 cache、
不复制 Recall selector。

### 18.2 无 association（机械证明）

`<line` / `createElementNS` / `createElement('line'` / `similarity` / `semanticLink`
出现次数**全部为 0**，且模块自报 `associationLines: 'DISABLED'`。
断层 / 雾 / 微尘都是纯 environment，不连接任何两个 memory 节点。

### 18.3 确定性（机械证明）

`Math.random` 出现 **0** 次。`Date.now()` 只出现在渲染计时
（`t0` 与耗时计算）与预览日期格式化里，**不参与任何布局或几何**。
`WORLD_SEED` 是固定常量；`bandGeometry()` 与 memory layout fingerprint 在真实页面重载后逐值相同。

### 18.4 渲染完整性

`renderedNodes === items` 在 0 / 1 / 200 / 500 / 1000 条下都成立 ——
视觉分层只改权重，**永不 sampling，永不隐藏 memory**。

### 18.5 断言总数

```
browser          = 54
side effects     = 37
layout / scale   = 35
visual contract  = 41
MEMORY_WORLD_ASSERTIONS = 167 PASS / 0 FAIL
```


---

## 19. UI-P1.3 · Cosmic Background Exact Closure（冻结）

本节冻结静态宇宙背景候选的最终呈现契约。§17.8 的全屏环境漂移与 §18.5 的 167 项断言是 UI-P1.1 / UI-P1.2 的历史记录；本阶段的运动边界和验证总数以下列值为准。既有记忆权威与交互语义继续保持。

```
MEMORY_WORLD_COSMIC_BACKGROUND       = PASS
MAIN_WORLD_MOTION                    = STATIC
MEMORY_NODE_MOTION                   = STATIC
ENTRY_ENVIRONMENT_MOTION             = SLOW_OPTIONAL_TIDE
ENTRY_TIDE_PERIODS                   = 26s / 41s
ENTRY_TIDE_REDUCED_MOTION_AWARE       = YES
ENTRY_TIDE_PAUSES_WHEN_HIDDEN         = YES
DARK_COSMIC_MATERIAL                 = YES
LIGHT_COSMIC_MATERIAL                = YES
LIGHT_WORLD_IS_DARK_INVERSION        = NO
COSMIC_BACKGROUND_SEMANTICS          = PRESENTATION_ONLY
MEMORY_WORLD_ROLE                    = PRESENTATION_LAYER_ONLY
MEMORY_WORLD_DURABLE_WRITES          = 0
ACTIVATION_WRITES                    = 0
MEMORY_WORLD_SEMANTICS_CHANGED       = NO
MEMORY_WORLD_ASSOCIATION_LINES       = DISABLED
POSITION_HAS_SEMANTIC_AUTHORITY      = NO
COGNITIVE_PRIVATE_STATE_EXPOSURE     = NONE
```

星云、远景星尘、空间弧线和环境洗色只表达空间氛围，不连接具体记忆节点，不表达关联、时间轴、因果关系、记忆聚类真值、语义接近度或重要性权威。节点布局、tier mapping、selection、hit testing、Finder、detail delegation、read / write authority 与 activation 语义均保持不变。

主世界不包含持续 Canvas 动画循环；仅入口的两个环境层执行可关闭的 CSS 慢潮涌，菜单文案为「入口潮涌」。入口在 reduced-motion 下停止，在页面隐藏时暂停。无新增图片资产或依赖。

```
browser          = 55
side effects     = 37
layout / scale   = 35
visual contract  = 48
MEMORY_WORLD_ASSERTIONS = 175 PASS / 0 FAIL
```

浏览器偏好恢复检查等待实际 data-motion 与入口 animation 状态，上限 3s，不使用固定 200ms 猜测。
