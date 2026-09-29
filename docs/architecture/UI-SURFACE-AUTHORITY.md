# UI Surface Authority（Desktop Shell）

状态：P1 已落地（2026-09-28）。本文记录**壳层/共享层**的视觉权威与护栏；业务模块内部视觉仍由各模块在自身阶段迁移。

## 1. 权威分层

| 层 | 文件 | 职责 |
|---|---|---|
| L1/L2 tokens | `assets/css/core.css` | 唯一 token 权威：`--glass-*` ladder、`--surface-*`、`--content-*`、`--border-*`、`--radius-*`、`--shadow-*`、`--motion-*`、`--space-*`、`--fs-*`、`--status-*`、`--layer-*`、`--focus-ring`；`surface.overlay` / `surface.dialog` 遮罩 token（P1 新增） |
| Navigation shell | `assets/css/navigation-shell.css` | **唯一导航来源**：几何（260/76px）、elevated 表面、行状态、折叠、响应式、Tauri titlebar 条。其他文件不得再声明 `#navbar` / `.nav-links` / `.nav-actions` 的几何与颜色 |
| pageChrome | `assets/css/core/api-components.css` 的 `.module-intro` 块 | `surface.pageChrome` 契约实现：透明底 + 底部发丝线、无玻璃/无模糊/无发光；类名保留，除非做 DOM 迁移不得改名 |
| 模块页视觉 | 各模块 CSS | 按 P3–P6 阶段迁移；壳层规则不越界，模块内部规则不越界回壳层 |

## 2. Surface role → token 快速对照（壳层）

| Role | 元素 | Tokens |
|---|---|---|
| `surface.navigation` | `#navbar` | `--glass-bg-elevated`、`--glass-filter-md`、`--border-soft`（右边）、`--layer-nav`；行状态 `--surface-hover/pressed` + `--accent` rail；文字 `--content-secondary/primary` |
| `surface.pageChrome` | `.module-intro` | `--border-soft`（底部发丝线）、`--content-primary`（标题）、`--content-muted`（caps 标签）、`--content-secondary`（描述）、`--mi-rule: var(--border-strong)` |
| `surface.overlay` | `#page-overlay.show` | `--surface-overlay-scrim`、`--surface-overlay-filter`（三秒交叉过渡） |
| `surface.dialog` + scrim | `.ib-cred-modal*` | `--glass-bg-modal`、`--glass-border-floating`、`--glass-shadow-modal`、`--surface-dialog-scrim`、`--radius-panel`；输入 `--surface-input`；危险操作 `--status-danger` |

## 3. 主题 / light-dark 权威

- 主题差异只在 token 块：Internal `:root` · Infernal `body.theme-infernal`。壳层**不得**再出现 `body:not(.theme-infernal) #navbar …` 一类逐元素主题补丁；导航文字全部读 `--content-*`（可读性由 token 值保证）。
- 页面遮罩的浅/深差异同样只由 token 承担（`--surface-overlay-scrim/-filter`），`#page-overlay.show` 只有一条规则。
- 切换仍是 `body.theme-infernal` class + 背景 4s / 遮罩 3s 交叉过渡，不新增“瞬间切换”路径。
- 遗留：`body:not(.theme-infernal) .page.active …` 浅色压色/白发光补丁属模块债务，随 P3–P6 模块迁移拆除，不在壳层内再扩建。

## 4. 护栏（P0 起持续生效）

```bash
node scripts/ui-guardrail.js check     # 结构白名单 + 视觉 KPI，任何回归退出码 1
node scripts/ui-guardrail.js update    # 仅在阶段验收通过、评审后重新冻结基线
```

- 基线文件：`scripts/ui-guardrail-baseline.json`（结构已知失败白名单 + 每文件/全局 KPI）。
- KPI 维度：`gradient`、`backdropFilter`、`bgRgba`、`bgHex`、`smallFont(<0.74rem)`、`bigRadius(≥20px)`、`important`、`rawHex`、`violet`（紫/蓝紫集合）、页面+JS 内联 `style=`（static/total）。
- 规则：**新增失败 = 0**；允许并鼓励下降。阶段验收后 `update` 把改善冻结为新基线。
- 结构基线：`tests/test_frontend_structure.js` 的既有失败（BOM 历史债 + 内联预算 + imageRouter 文案）已列入白名单；新增资产必须 UTF-8 BOM（`assets/css`、`assets/js`、`game`、`InternalBeyond.html`）。

## 5. 新增表面检查清单（P2+ 执行者）

1. 属于哪个 zone 密度（calm/standard/dense），消费哪些语义 token——先写下来再写 CSS。
2. 不做第三层玻璃；内层用 hairline/间距/`--surface-hover` 收。
3. 壳层改动只改 `navigation-shell.css` / `core.css` token / pageChrome 块；不要新增逐模块颜色。
4. 完成后跑 `node scripts/ui-guardrail.js check`；双主题各看一眼（Internal 雾 / Infernal 夜）。
5. 阶段范围：Workspace Home 头（P2）、Chat 核心（P3.1）与 Chat Family（P3.2）、Personal Space（P4）、Temporal & Activity（P5.1）、Voice（P5.2）、System Control（P6.1：API/Credential/Diagnostics）、Economy & Packaging（P6.2-A：economy 三件等值转换 + packaging/update 修复 + guardrail smallFont 正则升级为识别 `0.7x`/`.7x` 双形式）均已 token 化；Middle Brain（P6.2-B）见下条与第 7 条。

6. **Middle Brain Direct（审计结论，P6.2-B，未改一行）**：`middle-brain-direct.css` 本体已是 token 面（glass/modal/radius/filter/content 全走 core token；仅余少量 legacy `--text-*` 与 `.63–.68rem` 小字号，属独立秘密界面的既有约束，按政策不动）。两个可复核发现供后续决策：(a) 该文件的 `--radius-input` / `--radius-button`（L89/L95）在 core.css 中**不存在**，半径声明被浏览器丢弃（直角回退）；(b) legacy `--text-*` 在浅色主题下解析为深墨，而 Direct 场景恒为夜色底 → 该界面若在浅色主题打开会偏灰（secret surface 通常夜间使用，影响有限）。建议后续小步修复（补 token 别名或改 content 系），不在本轮范围。

7. 阶段范围（补）：Middle Brain Surface（P6.2-B）已完成——`mb-*` 全块（adv 卡/模型 swiper/档位条/reasoning 刻度/速度钮/折叠头/徽章）从「紫色科幻高级设置」迁移为 accent/status 认知控制面：**violet 残留 6→0**（含 #a855f7 速度钮）、core smallFont 9→4（余量为 Memory 弹窗等非 MB 段）、bigRadius 3→0；真实商品/哈希等身份渐变保留；MB runtime/Astra 链/credentialRef/provider-model/Direct 秘密路由零改动。MB 相关运行时套件中因本地 Bridge/Vault 服务未起而失败的用例（judge 遥测、credit 保存路径）经证据核验无任何 CSS 关联（0 命中），属环境依赖。

8. 阶段范围（补）：Desktop Remaining Surface Convergence（P6.2-C）已完成——Bridge / Activity / Guide 非叙事控件 / SetupWizard / DIY / LocalVault / EasterEgg 通用控件（地下室返回钮）+ 其余 desktop utility（music mini/panel、`.page-overlay`、mem-clean、empty-state、ICode 窗口字号与半径、local-first、HTML 内联 legacy 令牌）全部 token 化：**smallFont 67→6**（仅 mb-direct 政策保留）、**bigRadius 39→18**、**bgRgba 154→115**、**rawHex 266→225**、important 62→59、violet 保持 0；HTML 内联 `--text-*`/`--light`/`--silver`/`--glass-border|bg`/`--bg-card` **清零**；退役补丁：core.css #page-diy 6 行浅色压色块、#music-panel 浅色皮肤块（core L394 + widgets L98-111）、`.page.active [style*=•]` 玻璃边框补丁、`.empty-state` 浅色补丁、guide-toc 发光/浅色补丁。显式豁免（waiver）：EasterEgg 紫系母题（basement/lock/infernal-beyond）、splash welcome 语境、Guide 标题层白光（pages L73）、activity 影院视频 `#000` 字模、`.ibapp-overlay` 不透明宿主底与 `.wall` 洗色、星图/日历等叙事可视化。遗留（P6.2-D 候选，均为计数可见债）：ICode 窗口（core/workspace.css）完整 token 化（仍 ~80+ rawBg/rawHex，自成一派但成体系）、chat/memory/calendar/archive-active 冻结余量（含 999px 与浅色补丁）、JS 生成内联样式 ~16 处（core.js/memory.js/social.js 等）与 core.css `.modal/.chat-history-item` 作用域重映射补丁、core.css L392-393 全局 `.page.active/.modal` 白光补丁、economy/packaging 七个 `.7rem` 单数字形态（guardrail 正则盲区，建议扩展正则后再清）。

9. 阶段范围（补）：Desktop Visual System V2 Final Closure（P6.2-D）已完成——**D0**：取证证明 smallFont 正则漏检单数字 `.7rem/.6rem` 与 `<12px` px（旧式要求两位数字）；正则修正为 `0?\.(?:[0-6]\d?|7[0-3]?)rem` + `(<12px px)`，产品面（assets/game/HTML/JS）低于政策字号除显式豁免外全部归一（108→41，净修复 67 处）。**D1**：ICode 窗口 (core/workspace.css) 全量 token 化——bgRgba 83→0、rawHex 89→3、gradient 22→3、blur 14→8；「深夜冰潭」身份与双底层 1.4s 主题交叉淡化机制保留，两层改用 L1 原语 color-mix 重建（**ownership exception**：窗口双底层为机制所需）；blur(54px)→`--glass-filter-xl`；#fff 仅文档/iframe 白底保留（waiver）。**D2**：JS 生成样式视觉值迁移（bridge/core/memory/social/communication/site-operations/integrations/error-catalog/voicebox/workspace-files/backend-restart + game 通用件）→ content/glass/status/radius token；位姿/进度/状态等动态 style 全部保留；名称色板/终端 ASCII/塔罗场景常量列为豁免。**D3**：全局兼容补丁分五步退役并每步扫描验证——`.glass-card` 浅/暗双补丁对、`.ib-window-controls` 双色对、全局 `.page.active/.modal` 白光、弹窗输入/占位/选项改主题无关基础规则、孤儿 `--text-*`/chat-history 重映射、`.page.active .btn` 三件；另修 `.section-meta`/`.ib-email-link`/guide 许可链接三处真实浅/暗可读性点。**D4 门禁**：21 页×双主题×1440+1120 视口 = 0 未豁免淡墨/暗墨、0 横向滚动、0 页面异常（window.onerror=0）；guardrail exit 0、结构 16/0 new；内置浏览器实拍 Guide 页（无白光残留）。
