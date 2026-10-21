# Memory Atmosphere Layer · 记忆氛围层

> 契约文档 — 纯展示、可关闭、可整体移除的 Memory 页附加视觉层。
> 实现：`assets/js/memory-atmosphere.js` + `assets/css/memory-atmosphere.css`。
> 状态：layer v1.1（`memory-atmosphere-1.1.0`）。

## 1. 它是什么 / 不是什么

**是**：`#page-memory` 上的一层氛围 —— 从左侧探入的夜枝、极慢的摆动、飘落的花瓣、
更深的星雾纵深感，以及对记忆卡片**弱**的视觉呼应。

**不是**：不是第二套 Memory 世界、不是数据视图、不是新页面，也不改变页面结构。

- 数据权威：**无**。本层只读 DOM（`.mem-card` 数量、`.empty-state`、`.mem-card.mem-pinned`），
  `NEVER` 调用 `dbGetAll` / memory 运行时函数 / IndexedDB，`NEVER` 写入 memory。
- 交互权威：无。搜索 / 筛选 / 列表 / 详情弹窗 / Memory World 入口全部保持原状。
- 归属：`PRESENTATION_LAYER_ONLY`，全部视觉内容由 canvas / SVG 现画。

## 2. 挂载接缝（不改 InternalBeyond.html）

`InternalBeyond.html` 的样式表数量被 `tests/test_frontend_structure.js` 精确约束
（`split.externalStyleCount`），因此本层不能加静态 `<link>` / `<style>`：

1. `assets/js/memory-sky.js` 末尾的 `loadMemoryAtmosphere()` 以 id 守卫
   （`ib-mem-atmosphere-loader`）注入 `assets/js/memory-atmosphere.js`，与既有
   `loadMemoryWorld()` 完全同构，异常静默。
2. `memory-atmosphere.js` 在 `mount()` 里自己挂
   `<link id="ib-mem-atmos-style" href="assets/css/memory-atmosphere.css">`。
3. 卸载：删除上述 link / script、清掉 `window.IB.memoryAtmosphere` 与两处 `<body>` 直属
   DOM 节点 `#ib-mem-atmos-back` / `#ib-mem-atmos-front` 即可，页面无残留状态。

## 3. 层结构

```
body
├─ #ib-mem-atmos-back    position:fixed inset:0  z-index:1   pointer-events:none
│   ├─ canvas.ib-mem-atmos__nebula   星雾（烘焙一次 → 只用 CSS transform 漂移）
│   └─ canvas.ib-mem-atmos__motes    6–12 枚记忆微尘（烘焙一次 + CSS 漂移 + 26s 呼吸）
├─ #ib-mem-atmos-front   position:fixed inset:0  z-index:90  pointer-events:none
│   ├─ img.ib-mem-atmos__bough--main 近枝（data:image/svg+xml，颜色由 token 烘焙）
│   ├─ img.ib-mem-atmos__bough--far  远枝（1440+ 才显示；更细、更淡、无花簇）
│   ├─ div.ib-mem-atmos__resonance   卡片 hover/focus 时的微弱共振光点
│   └─ canvas.ib-mem-atmos__petals   花瓣（全屏，按帧绘制，30fps 上限）
└─ #page-memory .module-intro（页面真实内容流）
    └─ div.ib-mem-atmos__control-row
        └─ button#ib-mem-atmos-toggle  氛围开关（真实 button，aria-pressed，≥44px）
```

开关**不是**视口浮层：它插在 `#page-memory .module-intro` 内、紧随
`#mem-favorites-link`，因此永远随页面内容排布，不会覆盖统计条 / 卡片 / 工具条；
离开 Memory 页时随页面 `display` 一起消失。`#ib-mem-atmos-front` 保持
`pointer-events:none`，只做装饰。层叠：navbar 100 / 弹窗 10000 > front 90 >
`#app` 10 > back 1 > 背景图 0。装饰元素全部 `aria-hidden="true"`；只有开关参与
可访问性树。

## 4. 视觉 DNA

- 颜色：全部经 `getComputedStyle` 从 `core.css` 语义 token 解析（`--ib-token-*` /
  `--accent` / `--content-*` / `--glass-*` / `--status-warning` / `--mem-gold`），
  因此 Internal（雾白）与 Infernal（深蓝夜）各自成立，主题切换时重烘焙。
- 枝：为「左缘约 150×420px 可见切片」专门构图 —— 主干从画面左下以连续 S 形伸向右上，
  多条次级枝自然分叉、细枝梢 + 8 簇 5 瓣花（屏幕直径约 18–22px，暖金小花心）；
  右缘用 SVG mask 渐隐，枝条在进入文字列前溶解，不会硬切或压住正文。
  暗色近剪影 + 一线冷光；浅色雾蓝灰、低对比但可辨。
- 花瓣：两族精灵 —— 修长单瓣（边缘明确、只有极窄柔化）与 5 瓣小花剪影，
  单片视觉 7–13px、小花 10–14px（精灵预渲染 48px，按 9–18px 绘制），
  alpha 0.45–0.8，旋转 / 横摆 / 12–26px/s 缓落；
  暗色淡冰象牙白，浅色柔和蓝灰；稀有暖金花瓣只在置顶卡片共振时出现。
- 微尘：26s 的极慢 opacity 呼吸（0.55→0.9），让「若隐若现」存在但不抢注意力。
- 动效：单一缓动 `cubic-bezier(0.4,0,0.2,1)`，枝摆 18s / 24s 交替、星雾 120s / 168s、
  花瓣 12–26px/s；无弹跳、无霓虹、无第二视觉主角。
- 所有渐变 / 光晕 / 花簇画在 canvas 或 SVG 内（JS），CSS 文件不含任何原生色值与
  渐变声明。

### 响应式降级（枝)

| 视口 | 行为 |
| --- | --- |
| ≥ 1360px | 近枝可见约 150px 宽（220px 画框左移 70px）+ 150px 远枝 |
| 1100–1359px | 近枝缩放到约 64–74px 可见宽度，依赖 SVG 右缘渐隐避免压字；远枝隐藏 |
| < 1100px | 枝整体隐藏，只保留花瓣 + 星雾（氛围仍在，不遮挡任何内容） |

## 5. 性能契约（长时 WebView2 会话）

| 项 | 策略 |
| --- | --- |
| 背景星雾 | 一次性烘焙到 canvas；之后只有 CSS `transform` 关键帧（合成器），0 每帧 JS |
| 微尘 | 同一张 canvas 烘焙；168s 位移 + 26s opacity 呼吸，均为合成器动画 |
| 花瓣 | 单 canvas，8 枚精灵预烘焙（3 色 × 单瓣/小花 + 2 枚暖金）；12 基础 / 22 上限（安静态 6，窄屏 ≤14） |
| 帧率 | rAF 节流到 ~30fps；`approxFps` 为滚动 EMA |
| 分辨率 | 花瓣 DPR ≤ 1.75；单 canvas 像素面积 ≤ 2.4M（自动降采样） |
| 暂停 | Memory 页不 active / `document.hidden` / 关闭 / reduced-motion：停 rAF + `animation-play-state:paused` |
| 观察者 | 列表 MutationObserver 400ms 防抖；theme 变更 rAF 合并；resize 200ms 防抖 |
| 失败 | 全部入口 try/catch；失败仅隐藏本层并写 `lastError`，页面功能不受影响 |

## 6. 弱关联（只读 DOM）

- 花瓣密度随 `#mem-list` 中 `.mem-card` 数量温和缩放（12 → 22），空列表 / `.empty-state`
  进入 `data-state="quiet"`（6 瓣）。
- `pointerover` / `mouseover` / `focusin` 委托（节流 500ms）命中 `.mem-card` → 约 1.6s
  的共振：光点沿枝滑过 + 释放 1–2 瓣；置顶卡片（`.mem-pinned`）额外释放 1 枚稀有
  暖金色花瓣（唯一使用 `--mem-gold` 的地方）。
- 卡片集合增多（MutationObserver 防抖后计数上升）→ 最多 3 瓣的小 bloom；首次渲染只建立
  基线，不制造开局爆发。
- 不读取卡片文本、不建立节点映射、不写任何数据。

## 7. 公开 API

`window.IB.memoryAtmosphere`（`NS.expose`）：

```js
{
  version, mounted,
  enabled(): boolean,
  setEnabled(bool): boolean,
  toggle(): boolean,
  stats(): { mounted, version, enabled, pageActive, paused, reduced, petals, motes,
             dpr, width, height, frames, approxFps, mountMs, lastError, toggles },
  debug: { resonance(), bloom(), rebake() }
}
```

- `stats()` 只读内存字段，不触发布局。
- 开关持久化：`localStorage["ib.memory.atmosphere"] = "on" | "off"`，默认 `on`；
  关闭后 `#ib-mem-atmos-back` / 枝 / 花瓣 / 共振全部退出，仅保留开关本身。
- `prefers-reduced-motion: reduce`：枝与星雾静止、花瓣循环不启动。

## 8. 测试门禁

- `node tests/test_frontend_structure.js`：新 `.js` / `.css` 必须带 UTF-8 BOM；
  不得新增失败项。
- `node scripts/ui-guardrail.js check`：新 CSS 不得新增任何视觉 KPI（原生色值 /
  背景模糊 / 小字号 / 大圆角 / 强制优先级等）；新 JS 的 `style=` 计数必须为 0。
