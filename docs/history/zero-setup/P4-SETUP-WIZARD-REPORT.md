# P4 · First-Run Setup Wizard —— 完成报告

> 阶段目标：一个完全不了解编程和 IB 内部结构的普通用户，第一次打开 InternalBeyond 后，
> 可以通过向导完成 AI 配置、角色创建，并成功发送第一条消息。

**结论：P4 完成。** 真实 Chrome 端到端 smoke 60/60 通过，含「真正发出第一条消息并收到回复」。
停在本阶段，未进入 P5。

---

## 1. 修改文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `assets/js/setup-wizard.js` | **新增** | 向导模块（IIFE，`window.IBSetup` + `IB.setup`），约 1190 行 |
| `assets/css/setup-wizard.css` | **新增** | 向导样式，全部走 `core.css` 语义 token（深浅主题自动适配） |
| `InternalBeyond.html` | 改 **1 行** | `<script src="assets/js/setup-wizard.js"></script>`（挂在 `easteregg.js` 之后） |
| `test_setup_wizard.js` | **新增** | 静态契约 + 纯逻辑契约（86 项） |
| `test_setup_wizard_smoke.js` | **新增** | 真实 Chrome 首启端到端 smoke（60 项） |
| `test-all.js` | 改 | 登记两个新测试（static 34 / browser 48） |
| `docs/history/zero-setup/P4-SETUP-WIZARD-REPORT.md` | **新增** | 本报告 |

**未触碰**：`middle-brain.js`（并行会话在途，全程禁止）、`assets/js/error-catalog.js`（P3 契约原样复用）、
`assets/js/social.js`（保存链与角色表原样复用，未改一行）、`assets/js/core.js`（DB_VER 仍为 23）。

> 说明：`InternalBeyond.html` 认领期间无其他会话占用；改动为纯增量 1 行。收尾时把工作区丢失的
> UTF-8 BOM 补回（`test_frontend_structure.js` 的 `encoding.bom` 要求），HTML 现为 65 个本地脚本、
> 20 个样式表、静态内联样式计数 200（**预算未变**）。

---

## 2. Wizard 入口与状态判定

**状态存放**：`apiSettings` store 的两个私有 key（**不升 DB_VER**，随导出/导入一起迁移）：

| key | 内容 |
|---|---|
| `ibSetupV1Done` | `{id, done:true, skipped:boolean, version:1, at}`（或老用户升级时 `{migrated:true}`） |
| `ibSetupV1Draft` | `{id, step, provider, model, endpoint, noKey, nickname, relationship, desc, systemPrompt?, updatedAt}` —— **绝不含 apiKey / 头像** |

**判定（纯函数 `decide(rec, draft, rolesCount)`，测试覆盖矩阵）**：

| 情况 | 结果 |
|---|---|
| 无记录 + 无角色 | 自动进入向导（`first-run`） |
| 无记录 + **有角色**（老用户升级） | **不打扰**，静默写 `{done:true, migrated:true}` |
| `done:true, skipped:false` | 正常进入 IB，不再出现 |
| `done:true, skipped:true`（Skip 过） | 不再强制弹出，但**不是永久完成**：聊天区与 API 页均有重新入口 |
| 有草稿 + 未完成 | 继续上次步骤（`resume`） |
| `done` 非布尔 / 记录损坏 | 按未完成处理（0 角色时正常引导） |
| 状态**读取失败**（DB 不可用） | **不自动打开**，只 `console.warn` —— 绝不让主界面打不开 |

**入口**：
1. 首启自动：模块在 `DOMContentLoaded` 读状态 → 等 `#app.visible`/splash 消退后打开（不抢 splash 的按钮，不劫持导航）。
2. 聊天区空状态「**开始设置**」按钮（`#ib-setup-empty` → `#ib-setup-start`）。
3. API Settings 页「**重新运行设置向导**」按钮（运行时注入 `#api-add-actions`，不新建配置中心）。

---

## 3. 步骤结构（7 步）

| 步 | 标题 | 内容要点 |
|---|---|---|
| 1 | 欢迎 | 「几分钟完成第一次设置，不需要编程知识。」+ 三步清单 + 本地保存说明 + 「稍后设置」提示；degraded 时顶部插一条 P3 文案 |
| 2 | 选择 AI 服务 | provider 卡片（名称取自 `provider-directory.js`），切换即用该 provider 的默认 model/endpoint |
| 3 | 填写 API Key | `type=password` + 显示/隐藏；「使用本机模型，不需要密钥」分支 |
| 4 | 模型与接口 | 模型（预填默认值，可改）；**接口地址放在「高级设置」折叠区**；不出现 Bearer / 格式 / Responses API 等概念 |
| 5 | 测试连接 | 「测试连接」→ 真实调用链；成功「连接成功，可以使用。」；失败 → P3 内联卡片；另有「先不测试，继续」 |
| 6 | 创建角色 | 名字（必填，≤16，查重）、关系、简单描述、头像（可选）；「角色设定（系统提示词）」在高级设置 |
| 7 | 完成 | 「现在可以开始聊天了。」+ 摘要（角色/服务/模型）+「开始聊天」→ 写 `ibSetupV1Done` → `navTo('chat')` → 选中该角色 → 聚焦输入框 |

**UX**：上一步/下一步/步骤计数/进度条；表单错误就地显示（`#ib-setup-err-*`）且**重绘前先 `readFields()` 收集、重绘后回填**，任何校验失败都不会清空已填内容；`Enter` 前进（textarea 与按钮除外）、`Esc` = 保存草稿后关闭（不丢状态）；卡片 `max-height:92vh` + body `overflow-y:auto`；≤560px 单列布局。

---

## 4. 如何复用 `provider-directory.js`

- 唯一取数点：`window.PROVIDERS_DIR.PROVIDERS`（`providers()` / `providerMeta()` / `providerName()`）。
- 模块内**没有**第二份 provider 字面量：`test_setup_wizard.js` 断言 14 个 provider endpoint 主机名与 14 个默认模型 id 在向导文件中**一个都不出现**。
- 向导里唯一自带的 `PROVIDER_ORDER` + `PROVIDER_HINT` 是**呈现层**（卡片顺序与一句人话说明），不含任何 endpoint/model/format/vision/streaming 字段。
- provider 切换行为与现有 `onProviderChange()` 一致：换 provider → 用该 provider 的 `model`/`endpoint` 覆盖（不会残留上一个 provider 的值，smoke C3/C4 覆盖）。

---

## 5. 如何复用现有 API 保存链

**没有第二套保存逻辑**。向导只做「临时填充现有 API 编辑器 DOM → 调 `saveCurrentApi()`」：

```
addNewApi()                       // 现有函数：分配 editingApiId、重置编辑器状态
  → 填 api-ai-name / api-provider / api-model / api-endpoint / api-key / api-relationship / api-system
  → onProviderChange()            // 现有函数
  → window._pendingApiAvatar = <dataURL|null>   // 现有头像三态机制
  → saveCurrentApi(null)          // 现有函数：昵称/@handle 查重、_persistApiConfig、读回校验、刷新列表
  → window.apiConfigs.find(c => c.id === editingApiId)  // 校验真的保存成功
```

因此以下语义**与手动编辑完全一致**：昵称查重、`@账号` 规范化与查重、`_persistApiConfig` 的
IndexedDB→localStorage→session→memory 降级、`updatedAt` 写标记、保存后读回校验、
`renderApiList()`/`loadFriendsList()` 刷新、降级提示语（`_apiSaveNotice`）。
`test_setup_wizard.js` 断言向导文件不出现 `dbPut('apiConfigs'`、不出现 `_persistApiConfig`。

---

## 6. 如何写入角色数据

- 角色**只**写入 `apiConfigs`（唯一事实源），字段沿用现有模型：
  `id('friend_'+ts+rand)` / `nickname` / `provider` / `apiKey` / `model` / `endpoint` / `relationship` /
  `systemPrompt` / `avatar` / `temperature` / `streaming` / `vision` / `promptCache` … 由 `saveCurrentApi` 统一落盘。
- **没有新字段、没有第二张角色表**。
- 「简单描述」→ 系统提示词的映射规则（透明、可预期）：
  `systemPrompt = 默认设定 + '\n\n' + 描述`（描述为空则只写默认设定；两者都空则不写，等价于编辑器里
  「清空默认文本」的语义）。高级设置里的「角色设定」文本区显示的就是最终保存值，两者实时同步
  （未手动改过时，改描述即改文本区；手动改过则以文本区为准）。
- 头像沿用 `_pendingApiAvatar` 三态机制（`null`=不改 / `''`=移除 / dataURL=新图），不入草稿。

---

## 7. 测试连接实际调用链

```js
window.callApiChat(testConfig(S), [{role:'user',content:'你好'}],
  {maxTokens:16, timeoutMs:30000, disableTools:true, _noWebSearch:true, wantMeta:false})
```

- 走的是聊天同一条链：`callApiChat → _callApiChatOnce → _ibApiPost`（http 承载直连；file:// 才经 Bridge llm-proxy，Bridge 不可达会回落直连）。
- 临时配置 `{id:'__ib_setup_test__', provider, apiKey, model, endpoint, temperature:1, streaming:false, showThinking:false, promptCache:false, vision:false}`，**不落盘、不写 apiConfigs**。
- 该请求由 smoke 的 mock provider 实测校验：单条 `user` 消息、无 `tools`、非流式（F2/F3）。
- 任何字段变化（密钥/模型/地址）→ 上一次测试结论立即失效，必须重测（`readFields()` 内实现，smoke F0）。

---

## 8. Skip / resume 行为

| 行为 | 实现 |
|---|---|
| 「稍后设置」 | 写 `ibSetupV1Done{skipped:true}`、清草稿、关向导、toast「已跳过设置：聊天前需要先添加 AI 与角色」 |
| 跳过后主界面 | 照常可用（向导不阻塞任何导航） |
| 跳过后聊天区 | 注入空状态：「还没有可以聊天的角色 …」+「开始设置」按钮 |
| 跳过后重开 | 聊天区按钮 / API 页「重新运行设置向导」均可再次进入（**skip ≠ 永久完成**） |
| 中途关闭（✕ / Esc） | 写草稿（**不含密钥**）+ toast「已保存填写内容，下次打开可以继续」 |
| 下次打开 | 自动恢复到上次步骤；密钥字段为空，并在草稿恢复时明确提示需重新输入（smoke D6/D7） |
| 完成 | 写 `{done:true, skipped:false}`、清草稿、进入聊天 |

---

## 9. P3 错误接入

- 连接测试失败 → `IBERR.present(e, {stage:'setup_test', cfg:{id,provider,model,endpoint}, ...})`，
  向导内联卡片只渲染 `title / message / suggestion`，`technicalDetails` 经 `IBERR.detailsText()` 进「查看详情」（默认收起）。
- smoke 实测：普通提示不含 `401` / `127.0.0.1` / `http://` / `sk-` / `Bearer` / 原始 body 关键字；
  详情含「HTTP 状态：401」但**不含密钥**（E2/E3/E4）。
- 角色保存异常 → `IBERR.present(e,{stage:'setup_create_role'})` 生成就地错误文案，不拼原始 `e.message`
  （静态断言：向导文件中不存在 `e.message`/`err.message` 拼接）。
- degraded 启动 → 读 P2 的 `/__boot-state`，取 `degradedReasons[0].component` 交给
  `IBERR.model('local_service',{component})`，第 1 步顶部显示该 P3 文案（不出现 bridge/端口/URL）。

---

## 10. 首条消息端到端验证（不是「保存成功」）

smoke 用**真实 UI + 真实 HTTP + 真实流式链路**验证：

1. 向导完成后 `currentPage==='chat'`、`activeFriendId===新角色 id`（H4/H5）。
2. 在 `#chat-full-input` 输入「你好」→ 点 `#chat-send-full`（真人路径）。
3. mock provider（OpenAI 兼容 + SSE）收到 `stream:true` 请求并返回 SSE 分片；
   UI 出现用户气泡与助手回复「收到，这是第一条回复。」（H7/H8/H10）。
4. `chatMessages` 落库：`user` 1 条 + `assistant` ≥1 条（H9）。

即：向导创建的配置**真的能聊天**，而不是只写进了 IndexedDB。

---

## 11. 测试结果

| 测试 | 结果 | 说明 |
|---|---|---|
| `node test_setup_wizard.js` | **86/86 ✔** | 静态契约（编码/BOM/HTML 挂载/单一数据源/无第二套保存链/密钥安全面/文案）+ 纯逻辑（判定矩阵、校验、草稿载荷、状态容错） |
| `node test_setup_wizard_smoke.js` | **62/62 ✔** | 真实 Chrome 首启全流程 + 13 项验收场景；含小屏无横向溢出、深色主题 token 与合成对比度（≥4.5）、无未捕获异常、密钥未进 console/持久化；自然退出无泄漏（EXIT=0，无 LEAK） |
| `node scripts_check_html.js InternalBeyond.html` | ✔ | 65 个本地脚本语法检查通过 |
| `node test_frontend_structure.js` | 1 项失败（**非本次改动**） | 唯一失败为 `encoding.bom.assets\js\middle-brain.js` —— 并行会话在途编辑（HEAD 有 BOM、工作树无、该文件 P4 全程禁触）；本次新增文件与 `InternalBeyond.html` 的 BOM 均已核对 |
| `node test-all.js --quick` | **static 34 / 1 失败 · service 16 全绿** | 失败项即上条 `middle-brain.js` BOM；`test_setup_wizard.js` 组内 PASS |

smoke 验收场景覆盖：1 自动出现 ✔ / 2 切 provider 字段随目录变化 ✔ / 3 正确 Key 测试成功 ✔ /
4 错误 Key → P3 文案 ✔ / 5 角色落入 apiConfigs ✔ / 6 `ibSetupV1Done` 写入 ✔ / 7 刷新不重复 ✔ /
8 中途关闭+刷新可继续且不损坏数据 ✔ / 9 Skip 可进主界面并重开 ✔ / 10 degraded 下向导仍可用 ✔ /
11 密钥不进 console/diagnostic ✔ / 12 小屏幕可用（无横向溢出、内容可滚动）✔ / 13 真正发出第一条消息 ✔。
另附加：深色主题（Infernal）下使用深色 token、文字与合成背景对比度 ≥ 4.5 ✔。

---

## 12. 已知限制

1. **不探测模型列表**：审计里可选的「/v1/models 检测」未做，模型名取 provider 默认值 + 手改（避免在向导里引入第二套请求）。
2. **一次向导创建一个角色**：再加角色走现有 API 编辑器（向导是首启捷径，不是配置中心）。
3. **空状态通过包装 `navTo` / `loadFriendsList` 实现**（与 `local-vault.js` 包装 `loadApiSettingsUI` 同一模式）。
   若未来这两个函数被整体替换，需重新挂钩；这是「不改 social.js 一行」的代价。
4. **Esc 不做二次确认**：直接保存草稿并关闭（避免 `confirm()` 在无头/自动化环境阻塞），因此不存在「误关丢数据」，但也没有「确定要离开吗」提示。
5. **草稿会保存高级设置里的角色设定文本**（用户自撰、非密钥）；API Key 永不进草稿。旧版本若曾误写含 `apiKey` 的草稿，读取时直接丢弃。
6. **degraded 提示依赖 `/__boot-state`**：以 `file://` 直接打开时该请求失败 → 不显示提示（功能不受影响）。
7. **头像无体积上限**（沿用现有编辑器行为）。
8. **middle-brain.js 的 BOM 失败**为并行会话在途问题，不属于 P4 改动面。
9. 向导文案只做中文（与现有 UI 一致），未引入 i18n 框架。

---

## 附：测试命令

```bash
node test_setup_wizard.js          # 静态 + 纯逻辑契约（零网络）
node test_setup_wizard_smoke.js    # 真实 Chrome 首启端到端（需本机 Chrome/Edge）
node test-all.js --quick           # static + service 回归
```
