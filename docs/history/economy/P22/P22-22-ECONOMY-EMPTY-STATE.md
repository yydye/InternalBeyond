# P22-22 · Economy 空状态视觉与文案收尾

基线：`8b50e6b`（Release Tooling R2）。提交信息：`P22-22 · polish Economy empty states`。

这一阶段的目标只有一句话：

> **让两个空状态读起来像"系统状态"，而不是一页错误。**

它不扩、不改任何经济能力。三条硬边界：

```text
git diff -- services/ runtime/                       为空（后端一个字节都没动）
git diff -- 路由 / 契约 / 能力判定                     为空（没有新读面、没有新写面）
测试语义                                             一条都没有改（只改了被新文案钉住的字面量）
```

---

## §0 · 这一阶段看到的两个问题（来自真实截图）

```text
① 商店无目录        → 两张空卡片，每张里一张很小的线稿 + 两行字，
                       整块约 194px 高，卡片下面一大片空
② 钱包未初始化      → 说的是"还没有 IB Credit 钱包 / 这个角色还没有额度账户"
```

第 ② 条的措辞是这一阶段真正要改的东西：**"没有钱包"读起来像一个缺失的对象
或者一次失败，而真相是这台节点还没走过一次性的初始化。** 同一句话还会让人
去找一个"创建钱包"的按钮 —— 而那个按钮**不存在**（canonical 到今天为止只有
`bootstrapInitialCredit` 一条创建路径，界面没有第二条接缝）。

---

## §1 · A · Wallet empty state 的措辞

### 1.1 改之前 / 改之后

| 位置 | 改之前 | 改之后 |
|---|---|---|
| 概览（`economy-shell-core.js`） | `这个角色还没有额度账户` | `尚未完成 Initial Bootstrap` |
| 设置（`economy-configuration-core.js`） | `还没有 IB Credit 钱包` | `尚未完成 Initial Bootstrap` |

### 1.2 三句话各自回答一个问题（顺序就是用户读到的顺序）

```text
状态   尚未完成 Initial Bootstrap
原因   额度账户由 Economy authority 创建，不能手动新建：发放这一次初始额度之后，账户才会出现。
       初始额度只能发放一次，发放之后不能再补、不能再改。
下一步 在「设置 → 钱包与初始额度」里发放这次初始额度，只能发放一次。   ＋「去设置」
```

§A 逐字要求的三件事因此都在页面上，而且都在**默认可见**的那一层：

| 要求 | 落在哪里 |
|---|---|
| 钱包由 Economy authority 创建 | `walletAbsentWhy` |
| 用户不能手工创建 | `walletAbsentNoManual`（"界面上没有「创建钱包」这一步"） |
| 初始额度只能发放一次 | `walletAbsentOnce` / `walletAbsentBody` |
| **不要**增加创建按钮 | 这一块里只有「去设置」一个动作；`bootstrapInputCount === 0` |

### 1.3 刻意**没有**改的东西

- 按钮与成功文案逐字未动：`设置初始额度` / `初始额度已设置` / `再想想`。
  改的是空状态的语义，不是这条接缝的名字 —— P22-16 的交互断言因此继续成立。
- `REFUSAL_TEXT['wallet-not-found']`（"这位角色还没有钱包。"）也未动：它是
  一个**拒绝码的翻译**，不是这一格的标题。

---

## §2 · B · 技术说明：默认折叠，展开才有

### 2.1 之前 / 之后

```text
之前（概览 · 钱包那一格）：state = … · currency = … · canonical 状态词：… · 本页读到的只读面：…
之后（同一格）：            state = … · currency = … · canonical 状态词：…
                            · 本页读到的只读面：…
                            · endpoint：http://127.0.0.1:23118
                            · Home Node token：已配置（26 个字符，值不在这里显示）。
                            · runtime：浏览器页面直接读本机节点（X-IB-Protocol: 1，模式 = canonical）；
                              这一页没有额外的构建产物。
```

§B 逐字要求的三样（Home Node token / endpoint / runtime）现在都在展开区里，
而**默认折叠**这件事由两个结构事实保证，并被测试逐字钉住：

```text
.esh-technical      hidden === true        （默认收起，收起时高度 0）
.ecfg-technical     details 没有 open      （默认收起）
```

### 2.2 一条安全纪律（P5 契约）

**Home Node token 的值一个字符都不出现**：只说"配没配"和"多少个字符"。
理由与 P5 的诊断导出同款 —— 值一旦进了正文，就会进截图、进导出、进别人的屏幕。

```text
已配置（26 个字符，值不在这里显示）。
没有配置（本机节点因此按无凭据对待）。
这一层读不到（传输实现可能没加载）。
```

三行都取不到时**不猜**一个看起来合理的值。

---

## §3 · C · 布局：空状态那一块矮 37%~40%

### 3.1 只改排版，线稿**逐字未动**

```css
/* P22-18 */
.esh-empty{ gap:9px; padding:14px 0 8px }
.esh-empty-art svg{ （160×120 原始尺寸显示） }

/* P22-22 */
.esh-empty{ gap:5px; padding:4px 0 2px }
.esh-empty-art svg{ height:46px; width:auto; margin:0 auto }   /* 等比缩小显示 */
```

`viewBox="0 0 160 120"` 与 `width`/`height` 属性**一个字节都没有改** —— 缩的是
CSS 显示尺寸，因此：

```text
线稿仍然是完整的 4:3 线性轮廓（图上一条线都没有被裁掉）
P22-17 的 E4b（viewBox / fill="none" / stroke="currentColor"）继续成立
```

### 3.2 量到的数（真实浏览器，两套主题一致）

| 尺寸 | 空状态那一块 | P22-18 基线 | 矮了 | 线稿渲染尺寸 | 卡片高 |
|---|---|---|---|---|---|
| 1280×800 | **122.31px** | 194px | **37%** | 61.33×46 | 195.14px |
| 1440×900 | **122.31px** | 194px | **37%** | 61.33×46 | 195.14px |
| 390×780（mobile） | **117.31px** | 194px | **40%** | 56×42 | 180.27px |

### 3.3 保持的三件事

```text
玻璃卡（backdrop-filter 仍然在，两套主题各自有令牌）
inline SVG（页面上仍然没有一个 img、没有一个 emoji）
IB 风格（同一个 accent 族、同一条语法：安静的一枚标记 + 一行字）
```

### 3.4 明确**没有**做的事

```text
没有后台管理风格的表格线网
没有错误页风格（没有警示色、没有感叹号、没有 role="alert"）
没有靠 overflow:hidden 裁掉内容换高度（线稿是等比缩放）
没有动 .esh-card / .ecfg-card 的内边距与圆角（其它卡片一个字都没变）
```

---

## §4 · D · 字号与亮度：三档真的分开了

| 位置 | 改之前 | 改之后 |
|---|---|---|
| 空状态标题 | `.88rem` / `content-secondary` | `.96rem` / `font-display` / `content-primary` |
| 空状态说明 | — | `.72rem` / `line-height:1.62` / `content-muted` |
| 未初始化状态字 | —（原来是一句 note） | `1rem` / `font-display` / `600` / `content-primary` |
| 未初始化原因行 | — | `.74rem` / `content-secondary` |
| 「下一步」标签 | — | `.66rem` / `letter-spacing:.14em` / `content-muted` |
| 外壳标题 / 说明 | —（原来只有页签） | `1.16rem` 600 / `.75rem` + `.88` opacity |

判据用的是**对比度**而不是绝对亮度 —— 浅色主题里 muted 是 `rgb(82,111,150)`、
标题是 `rgb(26,50,98)`：后者的绝对亮度更低，但它在浅底上更清楚。用绝对亮度判
会得到一条假红（开发期实测过，所以判据写成了 WCAG 对比度）。

深色主题的三档（状态 > 原因 > 卡片脚注）单调，且四档文字都不低于 3:1。

---

## §5 · E · 页签：把"我在哪一格"说出来

### 5.1 一级页签（五个，逐字未变）

```text
概览 · 商店 · 我的资产 · 待处理 · 设置
```

页签之下新增**这一格的标题 + 一句说明**（`SECTION_COPY`，纯层唯一的文案出处）：

| 页签 | 标题 | 说明 |
|---|---|---|
| 概览 | 概览 | 这位角色现在有多少额度，以及它是怎么变成这样的。 |
| 商店 | 商店 | 这个域里现有的货架与商品目录 —— 能不能买由规则、预算与批准各自回答。 |
| 我的资产 | 我的资产 | 这位角色已经拿到的东西：物品与算力额度。 |
| 待处理 | 待处理 | 在等你决定的购买请求。 |
| 设置 | 设置 | 钱包与初始额度、预算限制、自主购买 —— 这三块决定这位角色能动用多少。 |

★ 标题与页签**同一批词**，因此"点了哪个页签"与"下面这一块"永远对得上 ——
这是可访问性要求，也是"用户在哪儿"的唯一答案。

### 5.2 设置二级页签（四个，逐字未变）

```text
待处理 · 钱包与初始额度 · 预算限制 · 自主购买
```

配置面板里新增二级标题 + `SECTIONS[].intro` 的一句说明；「待处理」那一格
**不画第二个标题**（它由外层提供），因此同一页上不会有两个"我在哪儿"的答案。

| 二级页签 | 说明 |
|---|---|
| 钱包与初始额度 | 一次性的初始额度。发放之后，这位角色才有额度账户。 |
| 预算限制 | 这位角色能动用多少的上限。上限不是余额。 |
| 自主购买 | 哪些购买可以不先问你。启用它不绕过审批。 |

---

## §6 · F · 验收

### 6.1 真实浏览器截图（`tests/test_p22_22_economy_empty_state_visual.js`）

★ 截图落 `%TEMP%\ib-p22-22-shots\`，**不写进仓库**（素材纪律：本阶段 PNG 新增 = 0）。

```text
1280×800   p22-22-acceptance-store-1280x800.png
           p22-22-acceptance-overview-1280x800.png
           p22-22-acceptance-settings-1280x800.png
1440×900   同上三张（-1440x900）
mobile     p22-22-acceptance-store-mobile.png（390×780）
           p22-22-acceptance-overview-mobile.png
           p22-22-acceptance-settings-mobile.png
```

### 6.2 逐条对照 §F 的四项检查

| §F 要求 | 判据（都在那条视觉测试里） | 结果 |
|---|---|---|
| 无溢出 | 3 个尺寸 × 4 种世界（商店空/概览未初始化/设置未初始化/有目录有钱包）：`document` 与面板的 `scrollWidth - clientWidth ≤ 1` | 12/12 通过 |
| 空状态不是 error page | 空状态那一块是 `role="status"`（不是 alert）；Economy 这一页里 `[role="alert"], .is-error, .error, [data-tone="error"]` 命中 **0** 个；空状态标题的色相不落进警示红 | 通过 |
| 技术说明默认折叠 | `.esh-technical` 全部 `hidden === true`；`.ecfg-technical` 全部没有 `open`；正文里**没有** `IB_HOME_NODE_TOKEN` / `ib_home_node_token` / `X-IB-Protocol` / `127.0.0.1` / `23118` / `runtime` 这些词 | 通过 |
| 深色主题层级清晰 | 状态 > 原因 > 卡片脚注三档单调；四档文字对比度都 ≥ 3:1 | 通过 |

### 6.3 这一阶段的测试总数

```text
tests/test_p22_22_economy_empty_state_visual.js              105 / 105 通过（新增）
tests/test_p22_17_economy_store_visual.js                     92 / 92  通过
tests/test_p22_16_economy_configuration_visual.js             86 / 86  通过
tests/test_p22_18_economy_experience_visual.js               157 / 157 通过
tests/test_p22_15_economy_approval_visual.js                  66 / 66  通过

tests/test_p22_16_economy_configuration_ui_core.js            60 通过, 0 失败
tests/test_p22_16_economy_configuration_ui.js                 59 通过, 0 失败
tests/test_p22_17_economy_store_ui_core.js                    62 通过, 0 失败
tests/test_p22_17_economy_store_ui.js                         62 通过, 0 失败
tests/test_p22_18_economy_experience_ui_core.js               66 通过, 0 失败
tests/test_p22_18_economy_experience_ui.js                    54 通过, 0 失败
tests/test_p22_15_economy_approval_ui_core.js                 62 / 62
tests/test_p22_15_economy_approval_ui.js                      55 / 55

tests/test_p22_19_economy_owner_scope.js                      PASS
tests/test_p22_19_economy_read_contract.js                    PASS（28 项）
tests/test_p22_20_economy_public_surface.js                   PASS（23 项）
tests/test_p22_20_economy_external_boundary.js                PASS（42 项）
tests/test_p22_20_economy_boundary_injection.js               PASS（31 项）
tests/test_p22_21_economy_v1_freeze.js                        51 / 51  通过（drift guard）
tests/test_p22_21_economy_v1_closure_audit.js                 40 / 40  通过
tests/test_p22_21_economy_golden_path.js                      57 / 57  通过
```

---

## §7 · 被新文案钉住的旧断言（**语义未改**，只改了字面量）

§A 要求把"没有钱包"换成"尚未完成 Initial Bootstrap"，因此有几条 `indexOf`
字面量必须跟着换。**每一条的判定语义都逐字保留**，而且都**加强**了：

| 文件 | 断言 | 语义 |
|---|---|---|
| `test_p22_17_economy_store_ui.js` C9 | 旧："还没有额度账户" | 新：说"尚未完成 Initial Bootstrap"、**不说**"没有额度账户"、给出 Economy authority 与"不能手动新建"、只有一个「去设置」、没有任何"创建/新建"按钮，点了真的切到设置页签 |
| `test_p22_18_economy_experience_ui.js` B3 | 旧：同上 | 新：同上（不画 `12,450.00`、给「去设置」） |
| `test_p22_16_economy_configuration_ui.js` C1 | 旧："还没有 IB Credit 钱包" | 新：说"尚未完成 Initial Bootstrap"、**不说**"没有 IB Credit 钱包"、给出 Economy authority 与"只能发放一次"、输入框仍然在 |
| `test_p22_16_economy_configuration_visual.js` ③-3 | 旧：同上 | 新：同上（**一个**主按钮 + **一个**输入框不变） |
| `test_p22_18_economy_experience_ui.js` A2 | 外壳 `children.length === 3` | 新：`=== 4` —— 多的那一件**只是**标题块（`esh-tabs` / `esh-section` / `esh-ownerbar` / `esh-panes`），页签数与顺序、面板数都没变 |
| `test_p22_17_economy_store_visual.js` ③-空状态 | 线稿 `w ≥ 140 && h ≥ 100` | 新：**等比缩放**（比例仍在 4:3 内）+ 尺寸不为 0 —— 因为它现在按 46px 高显示 |

`tests/test-all.js` 里补了一条说明：P22-22 的视觉核对与 P22-15/16/17/18 那四条
一样**不在**默认套件里（要开真实浏览器）。

---

## §8 · 这一阶段**没有**做的事（逐条点名）

```text
没有改 services/ 或 runtime/（后端 diff 为空）
没有加路由、没有加写面、没有加表
没有改 canonical 契约、能力判定或任何经济事实的算法
没有改测试的判定语义（只换了被新文案钉住的字面量）
没有加"创建钱包 / 新建钱包"这类按钮或输入
没有把 token 的值写进正文
没有减少任何一条只读面的读取（读面清单逐字未变）
没有把技术说明的默认开合状态改成展开
没有动 P22-15 的 approval 容器与 P22-16 的配置逻辑（只碰它们的文案与空状态排版）
没有进入 P23
```

---

## §9 · 交付物

```text
assets/js/economy-shell-core.js            文案 + 每格的标题/说明（SECTION_COPY）
assets/js/economy-shell.js                 标题块 / 未初始化那一格 / 技术说明四行
assets/js/economy-configuration-core.js    未初始化文案 + SECTIONS[].intro
assets/js/economy-configuration.js         状态块 / 二级标题 / 输入框提示
assets/css/economy-shell.css               空状态高度 + 层级 + 标题块 + 状态块
assets/css/economy-configuration.css       同上（配置面）
tests/test_p22_22_economy_empty_state_visual.js   §F 的验收矩阵（105 项）
tests/test-all.js                          补一条"这条视觉测试不在默认套件里"
docs/P22-22-ECONOMY-EMPTY-STATE.md         本文件
```
