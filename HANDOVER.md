# Internal Beyond · 交接文档

> 写给下一个对话：先读这份文档，再读代码。本对话时间为 2026-08-04，主题是给 Internal Beyond 补一个“本地 Bridge 后端”并接入前端。
> **2026-08-06 追加交接**：见文末「第 9 节·2026-08-06 追加交接（AI 主动规划 / 日记系统 / UI 精修 / 修复）」与「第 9.9 节·晚间补充（Edge TTS 修复 / 测试去时钟敏感 / 验证经验）」。本对话新增了 AI 自主规划主动消息、AI Diary 角色日记系统、Active 页 UI 精修，修复了日记输出解析与 API 编辑页头像显示问题，并重写了 Edge TTS 的真实 bug 与去时钟敏感的测试。

## 0. 一句话概括

本对话为 [InternalBeyond.html](InternalBeyond.html)（单文件个人 AI 陪伴站）新增并完善了一个**本地一键启动的 Node.js Bridge 后端**（[ib-bridge-service.js](ib-bridge-service.js)），提供表情包、心语墙、健康/定位/天气看板、酷狗点歌、Bark/ntfy 推送、上下文进度条、`/continue` 续写、AI 常驻会话（多模型）、AI 语音气泡（TTS）、多窗口同步等服务端能力，全部通过 WebSocket 工具与 REST 接口接入页面右下角的 Bridge 面板。

---

## 1. 仓库与文件状态

- 项目路径：`E:\InternalBeyond-main`
- 本地 git 基线提交：`e4074cc`（`chore: establish Internal Beyond baseline`）
- **用户明确要求：不要提交、不要碰 GitHub**（用户表示 GitHub 上没开仓库；本地仓库无远程）
- 工作区有大量未跟踪文件（见下），保持现状即可

### 本对话新增文件

| 文件 | 作用 |
|---|---|
| `ib-bridge-service.js` | 本地 Bridge 后端（约 1700 行，零依赖，Node 18+） |
| `start-bridge-service.cmd` | Windows 一键启动脚本（可见窗口） |
| `test_bridge.js` | 后端冒烟/功能测试（82 项断言，零依赖） |
| `test_dual_window.js` | 双窗口同步 + 重复初始化测试（需本机 Chrome/Edge，走 CDP） |
| `HANDOVER.md` | 本文档 |

### 本对话修改的文件

| 文件 | 改动 |
|---|---|
| `InternalBeyond.html` | 在 `</body>` 前新增注入脚本与样式，标记为 `/* ===================== IB Bridge 增强`（约 700 行 JS + 一段 CSS） |
| `README.md` | 新增本地 Bridge 章节、Android/OPPO 用法、酷狗/网易云说明、测试说明 |

### 本对话之前就存在、仍未跟踪的文件（不是本对话产物）

`.gitignore`、`active-message-service.js`、`start-active-service.cmd`、`start-vision-service.cmd`、`test_vision.py`、`vision/`

---

## 2. 用户背景与当前配置

- 用户主要设备是 **OPPO 手机（Android）**；电脑是 Windows。
- 用户有 **酷狗 VIP**；已把酷狗 Cookie 写入本机配置（见下），但**酷狗直连播放接口目前被服务端限制，Cookie 也无效**，因此页面点歌改为“打开酷狗”方案。
- 当前 `config.json` 实况：
  - `music.provider = "kugou"`，`music.kugouCookie` 已填入（**敏感，勿打印/勿写入文档**），`music.fallbackNetease = true`
  - `tts.enabled = false`（未配置真实 TTS Key）
  - `ntfy.enabled = false`（用户还没填 topic）
  - `bark.enabled = false`
  - `lan = false`、`token = ""`（未开启局域网/鉴权）
  - `proactive.enabled = false`（旧式主动消息，未启用；AI 常驻会话自带主动消息能力）
- 服务当前正在运行：`127.0.0.1:23115`（通过 `start-bridge-service.cmd` 打开的可见窗口）。

### 配置文件位置与自愈

- 数据目录（Windows）：`%LOCALAPPDATA%\InternalBeyond\bridge\`
- 包含：`config.json`、`whispers.json`、`health.json`、`geo.json`、`letters.json`、`sessions.json`、`resident.json`、`context.json`、`push_history.json`、`stickers/`、`tts_*.mp3`
- 后端启动时会：
  - 深合并默认配置（缺顶层或嵌套字段会自动补齐并写回文件）
  - 配置文件损坏 → 备份为 `config.json.broken-*` 并重建
  - 其他数据文件损坏 → 备份为 `*.json.broken-*` 并降级为空数据
- 改配置后必须**重启服务**（配置只在启动时读取一次）。

---

## 3. 后端架构（ib-bridge-service.js）

### 基本参数

- 监听：默认 `127.0.0.1:23115`；可用环境变量 `IB_BRIDGE_PORT` / `IB_BRIDGE_HOST` / `IB_BRIDGE_DATA_DIR` 覆盖
- `config.json` 里 `lan: true` 会改为监听 `0.0.0.0` 并打印局域网地址
- 纯 Node 内置模块，无 npm 依赖；WebSocket 为手写 RFC6455 实现

### WebSocket 协议（与页面 IBNET 客户端兼容）

- 握手：`hello {client, version, token, capabilities}` → `hello_ack {ok, server, tools}`
- `ping/pong`、`tool_catalog_request` → `tool_catalog`
- `tool_call {id, name, args}` → `tool_result {id, ok, text, data, images}`
- 服务端主动 `push {title, text, from}`
- 鉴权失败 close `4401`；Origin 非法（升级时校验）返回 HTTP 403；协议错误 close `1002`
- **注意**：`close()` 必须先发 close frame 再置 `closed=true`（曾因顺序错误导致 close frame 发不出去，测试抓出）
- CORS 白名单：`null`（file://）、localhost、127.0.0.1、::1；其余 Origin 一律不带 ACAO 头

### 工具清单（21 个，经 WS 暴露给 AI）

`echo`、`sticker_list`、`whispers_read/write/delete/update`、`health_read`、`geo_read`、`weather`、`music_search`、`music_url`、`webhook`、`bark_push`、`ntfy_push`、`tts_speak`、`push_send`、`letter_write/list`、`session_get/save`、`context_stats`

### REST 接口（分组）

- 健康/状态：`GET /health`、`GET /status`、`GET /api/tools`、`GET /api/config`（敏感值脱敏为 `***`）
- 表情：`GET /stickers`、`GET /stickers/<file>`
- 心语：`GET/POST /api/whispers`、`PATCH/DELETE /api/whispers/:id`
- 健康：`GET/POST /api/health`（metrics 严格校验，非对象安全兼容）
- 地理：`POST /api/geo`、`GET /api/geo/latest`
- 天气：`GET /api/weather?city=`
- 音乐：`GET /api/music/search|url|open|play`
- 信件：`GET/POST /api/letters`、`DELETE /api/letters/:id`
- 会话：`GET/POST/DELETE /api/sessions/:key`
- 上下文：`GET/POST /api/context?friend=`
- 推送：`POST /api/push`、`GET /api/push/history`
- TTS：`POST /api/tts`、`GET /tts/<id>.mp3`
- AI 常驻：`GET/POST /api/ai/sessions`、`GET/DELETE /api/ai/sessions/:key`、`POST /api/ai/chat`、`POST /api/ai/proactive`

### AI 常驻引擎

- 会话存 `resident.json`，支持 `openai` / `anthropic` / `gemini` 三种格式（由 `provider.format` 决定）
- Anthropic：合并相邻同角色消息，且请求副本末条必须为 user（主动消息会留下 assistant 结尾）
- Gemini：`{model}` 占位替换、`systemInstruction`、`x-goog-api-key`
- `POST /api/ai/chat`：回复结尾 `/continue` 自动续写（默认最多 2 次）；失败回滚用 `splice(userIdx)` 精确移除本轮 user 消息
- 会话级并发锁：同一 key 同时只能有一个生成任务，第二个返回“正在生成中”
- `POST /api/ai/proactive`：主动消息（剥离 `/continue`、历史截断 120 条），同时 WS push + Bark + ntfy
- 定时主动：`resident.json` 里会话 `intervalMin` 为分钟数；扫描间隔默认 60s，可用环境变量 `IB_RESIDENT_TICK_MS` 缩短（测试用 200）

### 音乐行为（重要）

- 酷狗直连播放接口（`m.kugou.com/getSongInfo`、`wwwapi/play/getdata` 等）**当前对这台机器全部返回“需要付费”，即使免费歌、即使带会员 Cookie**——酷狗服务端限制，暂时无解
- 因此页面点歌按钮走 `GET /api/music/open`：
  - 酷狗：先隐藏 iframe 触发 `kugou://kugou/play.html?hash=...` 唤起客户端/App，再 `window.open('https://www.kugou.com/song/#hash=...')` 网页兜底
  - 网易云（配置切换后）：打开 `https://music.163.com/#/song?id=...`
- `GET /api/music/play` 仍保留内嵌流式代理；酷狗失败且 `music.fallbackNetease !== false` 时按 `name` 参数自动切网易云外链（实测可放 200 audio/mpeg）
- 前端 `ibMusicPlay` 在 Bridge 未启动时也会直接尝试打开酷狗网页（fail-open）

### 推送

- Bark（iOS）与 ntfy（Android/OPPO）都支持；配置在 `config.json` 的 `bark` / `ntfy`
- `recordPush` 同时记录 bark/ntfy 状态到 `push_history.json`；`GET /api/push/history` 供前端“状态”页签展示

---

## 4. 前端接入（InternalBeyond.html 注入脚本）

### 定位标记

在 `InternalBeyond.html` 末尾 `</body>` 前：

- 样式：`<style>` 块（`#ib-bridge-fab`、`#ib-bridge-panel`、`#ib-ctx-bar` 等）
- 脚本：`/* ===================== IB Bridge 增强（本地一键后端配套） =====================` 开始，到 `})();` 结束

### 功能清单

- 右下角 **Bridge** 按钮（Great Vibes 花体英文，玻璃拟态，可拖动、位置记忆 localStorage `ib_bridge_fab_pos`，面板跟随按钮位置并做视口钳制）
- 面板 4 个页签：心语墙 / 生活看板 / AI 常驻 / 状态
  - 心语墙：写、删、✎ 修改（PATCH）
  - 生活看板：定位更新、天气、近 7 天健康、推送测试
  - AI 常驻：模型下拉（从 `apiConfigs` + `PROVIDERS` 推导 format）、新建/改/删、对话、让TA主动说、自动朗读开关、上次会话 localStorage 恢复
  - 状态：服务/数据统计、最近推送、Android/OPPO 提示、数据目录
- 表情：AI 消息里 `[sticker:名字]` 渲染成图（png→svg 失败回退，防重入），输入框旁 ◉ 选择器
- 音乐：`[music:ID|歌名]` 渲染为按钮，点击走 `/api/music/open` 打开酷狗
- 上下文进度条：Chat 顶部，70% 橙、85% 红；优先服务端 `/api/context`，离线用 localStorage 估算
- `/continue`：包装 `_assistantResponseParts`，仅当未达上限（2 次）时剥离标记并自动续写；达到上限保留标记；新用户消息重置计数（包装 `sendChatMessage`）
- 附件保护：自动续写时保存/清空/还原 `_pendingImages/_pendingFiles` 并重绘预览
- 多窗口同步：包装 `dbPut`（chatMessages 写入后写 localStorage `ib_chat_sync`），其他标签页 `storage` 事件防抖重载聊天
- TTS：AI 气泡上“🔊 朗读”→ `/api/tts` 生成语音条（播放/暂停/时长，全局互斥 `_ibTtsAudio`）；未配置时浏览器 `speechSynthesis` 兜底
- 重复初始化保护：`ibBoot` 计数守卫（`window.__ibBootCount`），`window.__ibBootFn` 暴露给测试
- 包装器有效性标记：`data-ib-wrapped` / `data-ib-wrapped-db`（无头测试用）

### 关键包装器（依赖全局函数，勿改名）

`window._tkRecord`、`window._assistantResponseParts`、`window.sendChatMessage`、`window.dbPut`、`window.ibMusicPlay`、`window.ibBridgeBase`

---

## 5. 测试

### 运行方式

```powershell
node --check ib-bridge-service.js
node --check test_bridge.js
node --check test_dual_window.js
node test_bridge.js        # 82 项，exit 0
node test_dual_window.js   # 6 项，需本机 Chrome/Edge（CDP 双标签）
```

### test_bridge.js 覆盖

健康/状态、CORS 白名单、心语增删改查、上下文、地理、通用会话、AI 常驻创建/对话//continue/并发锁/主动消息、TTS 未配置 503、表情列表/文件/路径穿越、无效音乐 ID、音乐打开、WS 工具调用/Origin/token、配置自动补齐/损坏自愈、健康兼容、推送历史、Anthropic/Gemini 适配（mock 校验请求体）、TTS mock 全链路、服务重启恢复、定时器重启恢复（`IB_RESIDENT_TICK_MS`）、数据文件损坏备份。

### test_dual_window.js 覆盖

CDP 开两个真实标签页：页面就绪、进入 chat 页、storage 事件跨标签触发同步计数、重复调用 boot 不重复创建面板。

### 测试基础设施注意事项

- mock 服务器用端口 0 自动分配（`listenFree`）；测试端口用 `usedPorts` 去重；Bridge 启动对 EADDRINUSE 自动换端口重试
- 早前有被强杀的测试进程残留占用 24000–25000 端口；若再遇 EADDRINUSE，检查该区间 node 监听进程（命令行含 `ib-bridge-service.js` 或 `test_bridge.js`）并清理，但**不要动 23115 的用户服务**

---

## 6. 已知限制与未验证项（诚实清单）

- 酷狗内嵌播放不可用（服务端限制）；当前方案是“打开酷狗客户端/网页”，深链是否唤起取决于本机是否安装酷狗
- Anthropic / Gemini / 真实 TTS / Bark / ntfy 只用 mock 或代码验证，未用真实 Key/设备端到端验证
- 浏览器交互类（弹窗、拖拽手感、自动播放策略、定位授权）未人工实测
- 双窗口测试用 localStorage 信号模拟 dbPut 包装器，未走“IndexedDB 写入→包装器→storage 事件”完整浏览器链路
- REST 接口无 token 鉴权（设计如此）；开 `lan` 时建议配 token + 防火墙/Tailscale
- 主聊天仍由浏览器直连各家 API；Bridge 不做主聊天代理（AI 常驻会话是独立于主聊天的一套）

---

## 7. 给下一个对话的操作速查

### 重启服务（PowerShell）

```powershell
# 1) 找到 23115 监听进程并确认是 ib-bridge-service.js 后停止
$c = Get-NetTCPConnection -LocalPort 23115 -State Listen
foreach($x in $c){ $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $x.OwningProcess); if($p.CommandLine -like '*ib-bridge-service.js*'){ Stop-Process -Id $x.OwningProcess -Force } }

# 2) 启动新窗口
Start-Process cmd.exe -ArgumentList '/c','start-bridge-service.cmd' -WorkingDirectory 'E:\InternalBeyond-main'

# 3) 验证
Invoke-RestMethod http://127.0.0.1:23115/health
```

### 常见路径

- 配置文件：`$env:LOCALAPPDATA\InternalBeyond\bridge\config.json`
- 数据目录：`$env:LOCALAPPDATA\InternalBeyond\bridge\`
- 注入脚本定位：`InternalBeyond.html` 搜索 `IB Bridge 增强`

### 用户偏好

- 中文交流
- 主要设备 OPPO（Android），推送走 ntfy、健康走 Health Connect/HTTP Shortcuts
- 酷狗 VIP；页面点歌按“打开酷狗”行为，不要试图改回内嵌流式
- 不需要提交 git / 不要碰 GitHub
- 对“看起来实现但实际没实现”非常敏感，交付前要给出代码证据与测试

---

## 8. 可能的下一步

- 用户尚未配置：TTS 真实 Key、ntfy topic、lan/token（可引导填写）
- 此前审计中标记“部分实现”的：#22 主聊天未接入服务端通用会话；输入状态条、MCP 按需加载等老清单项仍可做
- 若想恢复酷狗内嵌播放：需要更可靠的酷狗接口或用户从已登录浏览器复制真正的请求 Cookie（当前这份是登录接口返回串，且即使有效也被服务端限制）

---

*本文档只描述代码事实与已配置状态，不包含任何密钥原文。*

---

## 9. 2026-08-06 追加交接（AI 主动规划 / 日记系统 / UI 精修 / 修复）

> 本节由 2026-08-05～06 的对话追加，记录该对话在原有基础上做的全部改动与遗留问题。

### 9.1 一句话概括

本对话为 InternalBeyond 做了三件大事 + 一组修复：

1. **AI 自主规划主动消息**：升级原有主动消息系统——每轮正常聊天后由角色模型自主规划下一次主动联系（时间/意图/取消条件），程序负责调度、频率限制、免打扰、取消、去重与持久化；浏览器与 companion 双执行器防重复。
2. **AI Diary System（角色生命日志）**：角色拥有私人日记（非聊天消息），混合式生成——每周周记 + 每日 AI 规划 + 特殊事件（首次聊天/久别重逢）+ 手动「让她写一篇日记」「今天想写些什么？」，高价值日记自动联动 Memory。
3. **Active 页面 UI 精修**：保存按钮折行、设置三分组、三级文字对比度、开关三态、最长规划时间"约 N 天"辅助、底部留白、文案去重。
4. **修复**：日记输出"无法解析"（增加文本格式兜底）、API 编辑页头像空白（根因是 `api-thinking-hint` 缺失元素导致 `editApi` 提前抛异常）、IndexedDB 升级阻塞诊断。

### 9.2 项目定位（重要，后续必须遵守）

- **个人本地应用**（Windows 单机 + 可选本机 companion 服务），不是 SaaS。
- **不引入** RBAC、用户隔离、token 鉴权、复杂认证等企业级设计；安全审查只聚焦本地可靠性（状态一致性、防重复、崩溃恢复、数据损坏、API Key 泄露、本机安全）。
- 保持实现简单，不为假设的公网/多用户部署增加复杂度。
- 已写入项目记忆 `project/local-app-positioning.md`。

### 9.3 本对话修改/新增的文件

| 文件 | 改动 |
|---|---|
| `InternalBeyond.html` | DB_VER 16→17（`active_message_plans`、`diary_entries` store）；AI 规划主动消息模块（约 +1100 行）；AI Diary 模块（约 +600 行）；Active 页 UI 精修 CSS/HTML；导航新增「Diary」；API 页头像修复 |
| `active-message-service.js` | companion 支持 AI 计划：`plans` 状态（JSON v3）、`GET/PUT/DELETE /plans`、reconcile 扩展 `plan_ids`、`schedulerTick` 计划扫描与崩溃回收、`callCharacterModel` 增 `jsonMode`、`require.main` 守卫 + `module.exports`（供测试 require，启动方式不变） |
| `test_active_plans.js` | **新增**：30 项单元/状态机测试（`node --test`） |
| `test_active_http.js` | **新增**：31 项 HTTP 集成测试（真实起服务，随机端口） |
| `scripts_check_html.js` | **新增**：提取 HTML 内全部 `<script>` 块逐个 `node --check` 的语法检查工具 |
| `HANDOVER.md` | 本文档 |

> 注意：`ib-bridge-service.js` 与 `test_bridge.js` 的工作区改动是 2026-08-04 之前就存在的未提交修改，**不是本对话产物**，未触碰。

### 9.4 AI 自主规划主动消息（关键设计）

**数据流**：`sendChatMessage` 回复保存后 → `_activeMaybePlanNext()`（异步 600ms，fail-open）→ `planNextProactiveMessage()`（`callApiChat` jsonMode + 白名单校验）→ `_activeSaveAiPlan()`（同角色旧 AI 计划替换；绝不替换 `user_reminder`/手动计划）→ IndexedDB `active_message_plans` → 前端 `_activeTick` 30s 调度 + companion 15s 调度（互斥）。

**状态机**：`scheduled → evaluating(原子抢占) → sending → waiting_for_user`（用户回复后 `_activeUserReplied` 取消）/ `cancelled` / `expired`（迟到 >30min 不轰炸）/ `failed`（达 maxAttempts）；`evaluating/sending` 停留 >10min 崩溃回收。

**防重复（四层）**：① IndexedDB 事务原子抢占（`executedLock` 拒绝已执行计划回退，`executedAt` 单调合并）；② 浏览器/companion 互斥（companion 在线且已同步 → 浏览器跳过；浏览器判定离线 → DELETE 副本 + force PUT 抢占，收到 `stalePlan` → 本地标记 waiting 放弃）；③ 生成后复查状态；④ 消息 ID 秒级幂等。

**限制**：默认 `MAX_CONSECUTIVE=1`（用户未回复只发一条）；最短间隔 5min 下限/最长 7 天上限（可由偏好放宽区间，绝对边界不变）；免打扰 23:00-08:00（可配）；`allowFollowUpPlan` 默认 false，字段已存储供未来"连续陪伴"扩展。

**jsonMode 适配**：OpenAI 系 `response_format:{type:'json_object'}`（不支持的中转自动降级重试）、Gemini `responseMimeType`、Anthropic assistant 预填 `{"action":`；所有 provider 均有"严格 JSON 文本 + 容错解析"兜底。普通聊天/流式/DeepSeek think/GLM 隐藏链路零改动。

**companion 新端点**：`GET/PUT/DELETE /plans/:id`（PUT 带 stale/executedLock 服务端权威判定，DELETE 返回 `executed` 标记）；`/reconcile` 只清理调用方声明集合（`task_ids`/`plan_ids` 未声明的集合不动，防误删手动任务）。

### 9.5 AI Diary System（角色生命日志）

**存储**：IndexedDB `diary_entries`（`id/characterId/date/title/content/mood/diaryType(daily|weekly|event|emotion)/importance(0-10)/relatedMemoryIds/trigger/reason/createdAt`），导出/导入/重置已贯通。

**调度**（浏览器前端，companion 不扩展）：`_diaryTick` 挂 30s `_activeTick`——
- 每周周记：默认周日 22:00（可配日/时间），周水位线防重复；
- 每日 AI 规划：每角色每天一次 planner（`shouldWrite` + `importance>=6` 才生成），日水位线占位防重复；
- 特殊事件：首次聊天、久别重逢（间隔 >3 天）→ 事件日记（hook 在 `sendChatMessage` 单聊，fire-and-forget）。

**生成管线** `generateDiaryEntry`：`_diaryContext`（复用主动消息上下文加载）→ `buildDiaryPrompt`（第一人称私人日记，JSON 输出）→ `_diaryParseOutput`（JSON 优先，失败按用户规格文本格式「标题：/正文：/心情：」兜底）→ 相似度 ≥0.75 自动重生成一次 → 落库 → `_diaryWriteMemory`（importance≥6 且与现有记忆相似度 <0.8 才写 `memories`，`source:'diary'`）。

**UI**：导航「Diary」+ `page-diary`（角色筛选/搜索/统计/「让她写一篇日记」/「今天想写些什么？」/规划设置/时间线/删除）；API 编辑表单头像区「📖 日记」按钮直达该角色日记本。

### 9.6 Active 页 UI 精修（纯展示，业务零改动）

- 保存按钮：`white-space:nowrap;min-width:92px;flex-shrink:0`（小屏整体换行不拆字）
- 设置三分组：基础设置 / 频率与时间 / 行为与调试（`active-form-section-title` 轻分隔线）
- 三级文字对比度变量：`#page-active` 的 `--active-text-primary/secondary/muted`（浅色/`theme-infernal` 双主题）
- 开关三态：开启浅蓝强调 / 关闭灰白轨道+白滑块+悬停边框 / `.disabled` 整项降透明
- 最长规划时间：辅助文字「约 7 天」动态联动（`_activeUpdateMaxHoursHint`，纯展示不改存储单位）
- 底部留白 `padding-bottom:max(104px,env(safe-area-inset-bottom))`；文案去重

### 9.7 本对话的修复记录（重要，避免重蹈覆辙）

| 问题 | 根因 | 修复 |
|---|---|---|
| 日记点击生成报"日记输出无法解析" | 只支持 JSON 解析，模型返回文本格式 | `_diaryParseOutput` 双格式解析 + 重试提示 + `maxTokens` 1400→2000 |
| API 编辑页头像空白 | **`api-thinking-hint` 元素在 HTML 中不存在**（历史遗留，仅 JS 引用），`editApi` 第 8867 行无保护访问 → 抛异常中断 → 头像渲染代码从未执行 | 两处（`editApi`/`addNewApi`）hint 访问加 `if` 保护；另加头像多字段兜底（`avatar→avatarUrl→character.avatar/avatarUrl/image`）+ 损坏头像 `onerror` 回退占位 + `console.log('API Editor character avatar:')` 调试日志 |
| 控制台 `IndexedDB ... reading 'transaction'` | 旧标签页持有旧版数据库连接，新页面升级被阻塞（`db` 未就绪，走 localStorage fallback） | `openDB` 增加 `onblocked` 监听（控制台 + toast 提示关闭旧标签页） |
| 导航「日记」中文 | 用户要求英文 | 改为 `Diary`（与导航其他项一致） |

### 9.8 测试（本对话新增）

```powershell
node --check active-message-service.js
node scripts_check_html.js InternalBeyond.html      # HTML 内全部 script 块语法检查
node --test test_active_plans.js                    # 30 项：计划校验/状态机/连续限制/崩溃回收/时间戳完整性
node --test test_active_http.js                     # 31 项：/plans 端点/stale+executedLock/畸形 URL 不崩/reconcile 互不误删/403/脱敏
```

所有验证最终状态：30/30 + 31/31 通过，语法 0 失败。`test_bridge.js`（82 项）与 `test_dual_window.js`（6 项）未在本对话重跑（未触碰 Bridge 代码，如需要可重跑）。

### 9.9 2026-08-06 晚间追加（Edge TTS 修复 / 测试去时钟敏感 / 经验补充）

> 本节由后续对话追加，记录对 `test_active_plans.js` 的实测修正、Edge TTS 的真实 bug 及验证方式。这些是本项目**已经验证为真**的事实，供后续对话避免重蹈覆辙。

**9.9.1 `test_active_plans.js` 曾依赖系统时钟（已修）**

- 原 `basePlan()` 默认 `cancelConditions.respectDoNotDisturb = true`，且 DND 窗口为 `23:00–08:00`。在凌晨这段窗口内运行测试，到期计划会被顺延（`reschedule`）而非发送/取消，导致 `executePlan：多窗口`、`不同角色计划互不影响`、`schedulerTick：到期计划` 三个用例**稳定失败**（不是逻辑错，是环境时钟）。
- 已修：`basePlan()` 默认改为 `respectDoNotDisturb: false`；DND 专项用例 `executePlan：免打扰延后` 显式声明 `respectDoNotDisturb: true`。测试与运行时刻解耦。
- **经验：本套件对任务执行依赖系统当前时间，改造前务必先跑一次确认基线；若某用例在白天过、晚上挂，优先查 DND/时间窗口。**

**9.9.2 Edge TTS（`ib-bridge-service.js` 的 `edgeTtsGen`）真实不可用，已重写（这是最隐蔽的一处）**

- **帧构造 bug（实锤）**：旧实现 `header[1] = 0x80 | ssmlBuf.length` 用单字节编码载荷长度。SSML 最短也有几百字节（实测 1526 字节），被编码成 `0xf6`，服务端解出的长度是 118（1526 mod 128），帧必错乱。**`edgeTtsGen` 从未正常工作过**，之前靠 mock 测试没暴露。
- **数据丢弃 bug（实锤）**：旧 `s.on('data')` 中握手之后的 TCP 段整体被丢弃（`buf` 每次重置），音频帧只剩握手残留那几字节。真实 Edge TTS 音频分多个 TCP 段到达，必收不全。
- **详见 `test_bridge.js` 为何测不出**：mock 只验证「请求体正确」，没验证客户端 WS 帧打包逻辑。
- **修复**：新增 `wsFrame()`（mask + 126/127 双分支）+ 累积式帧解析循环 + `turn.end`/close 帧收尾 + `finished` 防重复 resolve。
- **真实服务端返回 403**：本项目当前网络环境直连 `speech.platform.bing.com` 返回 403（IP/地区限制，非代码问题）。**修复后的行为**：失败时前端 `_ibTtsSpeakImpl` 现在会调用 `ibTtsFallback`（浏览器 `speechSynthesis` 降级），功能仍是通的。
- **本次验证方式**（沙箱无法 spawn 子进程、也无法真实连 Edge）：本地 TCP mock 服务端注入真实 WS 帧解析，分 3 个 TCP 段发送音频/turn.end/close，验证 `edgeTtsGen` 收全并写盘。**遗留：未在真实 Edge 环境端到端验证；切勿删掉本地 mock 验证脚本复制的改法而不重新验证协议。**

**9.9.3 前端 `InternalBeyond.html` 三处修复（已列入上文 9.3 修改清单的一部分，但背景需交代）**

- `ibTtsFallback(text, btn)` 早已定义但**从未有任何调用点**（README 宣称的“浏览器语音降级”实际从未生效）。已在 `_ibTtsSpeakImpl` 的失败/异常分支补上调用。
- AI 消息多贴纸时 `[sticker:A]` + PNG 加载失败的回退会串名（`onerror` 捕获的是循环末尾最后一个名字）。已改 IIFE 闭包捕获各自的贴纸名与元素。
- 表情弹窗的 document 级 click 监听器每次打开注册、只有点外部才注销，未点击关闭时累积。已抽 `_ibClosePop()` 统一注销。

**9.9.4 沙箱/验证经验（本项目已踩过）**

- 受限沙箱下 `node --check` 单文件可用；但 `test_bridge.js` / `test_active_http.js` / 早期 `scripts_check_html.js`（用 `execFileSync(process.execPath)` spawn）会报 `spawn EPERM`——**不是项目问题，是沙箱限制**。需验证主 HTML 全部内联 script 块时，直接提取各块用 `node --check` 单独跑。
- PowerShell 5.1 的 `Invoke-RestMethod -Body` 发送中文默认按 Latin-1 转成 `?`。冒烟测试中文入参需用 `[Text.Encoding]::UTF8.GetBytes()` 构造 body，否则会误判“服务端中文坏了”。
- 校验 Bridge HTTP 时务必用 `IB_BRIDGE_DATA_DIR` 指向临时目录再做写操作，避免污染用户真实数据；结束时清理临时目录与测试监听进程。
- 改配置/新增注入后，本地 `file://` 打开务必 `Ctrl+F5` 强刷，浏览器缓存会给你“改动没生效”的假象（同上文 9.11）。

### 9.10 待解决问题（诚实清单）
1. **日记特殊事件未全覆盖**：生日、关系等级变化、赠送内容等项目**无现成数据源**（`about` 无生日字段、无关系等级系统），当前由每日 planner 的输入范围覆盖；若未来加生日/等级字段，可补 `_diaryMaybeEvent` 的 trigger 分支。
2. **日记调度仅浏览器前端**：companion（`active-message-service.js`）未扩展日记调度，浏览器关闭时不会自动写日记（手动生成仍可在页面打开时进行）。如需后台日记，需在 companion 增加 plans 同款机制。
3. **双执行器极小竞态**：companion 误判离线 + DEL/PUT 双网络失败的理论窗口下可能双发（消息 ID 秒级幂等为最后兜底）；属设计权衡，不阻塞。
4. **既有架构风险（按定位接受）**：companion 无鉴权 + null-origin 放行（`file://` 必需），Firefox/旧 Safari 无 PNA 保护时公网页面理论上可读写本机服务——按"个人本地应用"定位接受，不做架构级改造。
5. **UI 遗留小项**：设置卡「免打扰结束」单独占左列、「主动规划方式」select 半列孤行（分组对称性取舍）；深色主题（`theme-infernal`）下三级文字实际观感需真机核对。
6. **噪音报错（无害）**：`bg-canvas.jpg` 404（背景图缺失）、Cloudflare RUM 脚本在 `file://` 下 CORS/sendBeacon 报错——均不影响功能。
7. **`api-thinking-hint` 元素缺失**：JS 已加空值保护（不报错）；若未来在 HTML 中补回该元素，提示文字会恢复显示（GLM 默认关闭 / DeepSeek 默认开启说明）。
8. **`active-message-service.js` 的 `module.exports` 变化**：文件被 require 时不再自启（`require.main` 守卫），`start-active-service.cmd` 直接运行方式不受影响。

### 9.11 给下一个对话的操作速查

- 强制刷新页面用 `Ctrl+F5`（本地 `file://` 打开，浏览器缓存易导致"改动没生效"假象）。
- 若看到"数据库升级被其他标签页阻塞"：关闭旧标签页后刷新。
- 打开 API 编辑页时控制台会输出 `API Editor character avatar:` 日志，排查头像问题先看它。
- 日记生成失败时控制台输出 `[Diary] output unparseable:`（模型原始输出前 300 字），排查解析问题先看它。
- 项目定位记忆已持久化（`project/local-app-positioning.md`），后续开发默认遵循。

### 9.12 2026-08-08 前端可维护性与回归基线

- `InternalBeyond.html` 已从约 2 MB 的内联单文件拆为入口 HTML + `assets/css/{core,calendar,bridge}.css` + `assets/js/*.js`。仍是原生经典脚本按原顺序加载，**无构建步骤，直接打开 HTML 的启动方式不变**。
- 前端拆分文件统一为 UTF-8 BOM，并增加 `.editorconfig`，避免 Windows PowerShell / 编辑器把合法 UTF-8 显示成乱码。
- 全局新增语义设计变量（surface / content / border / focus / shadow / radius / motion / font / spacing / status），Light 与 `body.theme-infernal` 分别覆写；Bridge 工具箱复用同一套变量。
- 静态 HTML 内联 `style` 已从 316 处降到不超过 200 处；保留项主要是依赖 `element.style` 的运行状态或按数据动态计算的几何值，不能机械改成 class。
- 导航链接补齐 `href`、键盘行为和 `aria-current`；Bridge 增加 non-modal dialog 语义、关闭焦点回收、页签方向键、`inert` / `aria-hidden` 状态；添加 Skip Link 与 reduced-motion 处理。
- 性能：移除重复 Cloudflare beacon；资源拆分后可单独缓存；页面后台时暂停雨效、音频可视化、Bridge 轮询与 Calendar 高频读数。
- 新增回归入口 `test-ui.cmd`，包含：
  - `scripts_check_html.js`：全部本地脚本语法；
  - `test_frontend_structure.js`：UTF-8、资源路径、拆分约束、设计变量、内联样式预算、入口语义；
  - `test_ui_regression.js`：真实 Chrome / Edge 的 Desktop / Mobile、Light / Dark 实时切换、Bridge 点击 / 键盘 / 页签 / 焦点 / 边界与 JS error；
  - 原 `test_dual_window.js` 已改为动态 `file://` 路径，并断言旧 Bridge FAB 为 0、新导航入口为 1。

### 9.13 2026-08-13 游戏模块拆分（game/ 六文件）

- `game/game_module.js`（5647 行单文件）按域拆为六个原生脚本，仍在 `assets/js/calendar.js` 之后、`room-integration.js` 之前按原语句顺序加载，无构建步骤：
  - `game_module.js`（约 1614 行）：房间核心（配置 / CSS 注入 / 状态 G / 视口 / 寻路 / 点击与交互分发）；
  - `game_tarot.js`：塔罗（牌组数据 / 牌面 / 牌阵 / 抽牌与解读 UI）；
  - `game_story.js`：Story（AI 分支叙事引擎 + 故事视窗演出）；
  - `game_dialogue.js`：对话（分页 / 打字机 / Sui 问答 / 家园导览，`window.startHomeTour` 在此导出）；
  - `game_room.js`：房间尾段（换装 / 渲染循环 / 精灵 / 存档 / 面板与宠物窗 / bootstrap 与 `window.G` 导出）；
  - `game_tea.js`：茶歇（茶点数据 / 选单 / 精灵动画 / 聊天与存档）。
- 拆分方式：保持原 IIFE 的语句顺序，把函数/常量声明按域平移为顶层全局声明（各文件开头补 `'use strict'` 保持原严格模式语义）。已做碰撞审计：六个文件的 202 个顶层标识符与 `assets/js` 全部顶层标识符零冲突；三个 CSS 模板（CSS / TEA_CSS / STORY_CSS）的 `${...}` 插值全部只引用同文件或更早加载的声明，无 TDZ 风险。
- 行为约定（测试经验）：角色开局处于 sleeping，`onInteract` 会吞掉 sleeping/waking 状态的交互点击；对话打字机打完当前页不会自动翻页，需要点击 next 触发 `advanceDialogue`（第一击收尾打字、第二击翻页、末页触发回调）；Sui 交互需要先走到床边。
- 新增 `test_game_smoke.js`（零依赖 CDP，需本机 Chrome / Edge）：35 项断言覆盖六个模块加载、引擎初始化、塔罗 / 换装 / 茶歇选单 / 故事视窗 / 对话分页 / Sui 问答 / 行走 / 存档 / 主题联动 / 宠物窗，并断言全程无未捕获异常。已接入 `test-ui.cmd`。
- 本次全量回归全部通过：`scripts_check_html.js`（24 个本地脚本语法）、`test_frontend_structure.js`、`test_game_smoke.js`（35/35）、`test_ui_regression.js`、`test_bridge.js`、`test_active_http.js`（31/31）、`test_active_plans.js`（31/31）、`test_dual_window.js`。
- 注意：`InternalBeyond.html` 的 UTF-8 BOM 在文本编辑时容易被工具剥掉，`test_frontend_structure.js` 的 `encoding.bom` 断言会拦截（本次踩过一次，已恢复）。

### 9.14 2026-08-13 统一测试入口 + Bridge 渐进模块化（进行中）

按与 Codex 对齐的路线执行：test-all 统一入口 → Bridge 逐叶提取（composition root 不动）→ Active 同样处理 → `window.IB` 命名空间 → 前端大文件再拆 → CSS 按原顺序拆。

- 新增 `test-all.js`（零依赖，跨平台）：`--quick`（static + service，约 17s）、`--browser`（Chrome 集成组，串行）、`--all`（默认）。子进程输出透传、任一失败非零退出、分组耗时汇总。服务测试自带随机端口与临时数据目录（`test_bridge.js` 用 `IB_BRIDGE_PORT`/`IB_BRIDGE_DATA_DIR`）。
- Bridge 第一步提取（本次完成，82 项断言全绿）：
  - `bridge/util.js`：无状态工具（deepMerge / backupBrokenFile / uid / todayStr / constantTimeTokenMatch / parseQuery）；
  - `bridge/config.js`：`createConfig({ dataDir, writeJson })` 工厂，收拢 config / configRaw / configInvalid / LAN_EXPOSED / BIND_HOST 与鉴权辅助（isLoopbackRequest / suppliedToken / needsHttpToken / httpAuthorized）；
  - 依赖注入约定：工厂只接受显式依赖（`writeJson(file, obj)` 由根文件提供），避免 CommonJS 多文件循环依赖；根文件 `ib-bridge-service.js` 仍是 composition root，工厂返回值绑定为原有名字，其余部分无感。
  - 踩坑记录：`diagnosticsSnapshot` 引用了移入工厂闭包的 `configInvalid`，首跑被 82 项断言抓出（`diagnostics.snapshot` 失败），已把 `configInvalid` 加入工厂导出。
- 本轮（9.14 续）已完成三片叶子，每步后 82 项断言全绿：
  - `bridge/clients.js`：`createClients({ config, getGeoLatest })` —— 天气（wttr.in）、网易云/酷狗搜索与播放、Bark/ntfy 推送；
  - `bridge/tts.js`：`createTts({ config, uid, ttsDir })` —— Edge 免费 TTS（含 WS 帧构造与累积式帧解析）与 OpenAI 兼容 TTS；
  - `bridge/persistence.js`：`createPersistence({ dataDir })` —— 无状态 JSON 文件原语（jsonPath/writeJson/saveJson/loadJson/loadList/saveList/fileSummary/directoryUsage）。
  - 设计决策：可变业务状态（whispers / healthData / geoLatest / letters / sessions / resident / contextStats / pushes）与列表锁**保留在 composition root**——根文件对它们有 4 处重新赋值（删除心语、写入定位、删除信件等），若把状态搬进工厂闭包会引入别名漂移（保存时写回旧引用）。"根文件拥有状态、模块拥有逻辑"是本项目的注入约定。
  - 根文件已从约 2350 行降至约 1627 行。
- 后续轮次完成（每步后 82 项断言全绿）：
  - `bridge/ws.js`：`createWs({ config, executeTool, tools, maxFrame, serverName, version, pushHistory, withListLock, uid, savePushes })` —— 心跳 / recordPush / broadcast / WSConnection（含 close 帧先发后置 closed 的修复）；wsSockets 随工厂返回共享引用；
  - `bridge/routes.js`：`createRoutes(ctx)` —— sendJsonRes / corsHeaders / rateCheck / readBody / safeConfigSnapshot / diagnosticsSnapshot / handleHttp。**关键技巧**：whispers / geoLatest / letters 在路由内存在重新赋值，通过 getter/setter 注入（`getWhispers: () => whispers, setWhispers: v => { whispers = v; }`）保持与根文件绑定一致，避免别名漂移；其余状态仅原地变更按引用注入。
- **Bridge 拆分完成**：`ib-bridge-service.js` 从约 2350 行降至约 998 行，成为纯 composition root（常量 / 业务状态与锁 / 表情 / 工具目录与 executeTool / AI 常驻引擎 / 低频主动消息 / 服务器启动与升级握手）。bridge/ 下 7 个 CommonJS 模块全部私有作用域 + 显式接口，依赖一律经工厂参数注入，无循环依赖。
- 最终验证：`node test-all.js --all` 三组全绿（static 2 项 1.7s / service 3 项 17.3s / browser 3 项 25.3s，总 44.3s）。
- 下一目标（按既定路线）：Active 服务同样按真模块拆分（plan-domain / scheduler / model-client / persistence / http），再 `window.IB` 命名空间收拢前端。

### 9.15 2026-08-13 Active 拆分 + window.IB 命名空间（进行中）

- Active 服务按真模块拆分（`active/` 目录，CommonJS 工厂 + 依赖注入，与 bridge 同一套约定）：
  - 本轮完成 `active/persistence.js`：`createPersistence({ dataDir, getState })` —— 状态加载（主文件 → .tmp → .bak 依次恢复）、原子写入（临时文件 + fsync + 备份轮换）、50ms 合并保存队列。
  - **关键决策与踩坑**：`resetStateForTest`（测试钩子）会重新赋值 `state`，所以工厂不能持有 state 引用；改用 getter 注入（`getState: () => state`），序列化时读取当前绑定——与 bridge/routes 的 getter/setter 模式统一。首版把 state 放进工厂闭包，被 `test_active_plans.js` 的 `Assignment to constant variable` 当场抓出，已修复。
  - 验证：`test_active_http.js` 31/31、`test_active_plans.js` 31/31 全绿。
- `window.IB` 命名空间骨架：
  - 新增 `assets/js/ib-namespace.js`，在全部 assets 脚本**之前**加载：创建 `window.IB`、`IB.section('chat.letters')` 自动建链、`IB.expose(name, exports)` 幂等合并注册。
  - 迁移约定：迁移期**双挂载**（window 与 IB 同时保留），全部文件迁移完成后再移除 window 挂载；因此任何脚本的加载顺序与全局调用不受影响。
  - 本轮迁移 3 个零跨文件依赖的叶子作为示范：`email-links.js`（IB.email.revealIBEmails）、`room-integration.js`（IB.room.moveRoomTab / isRoomEdgeTab）、`preloader.js`（IB.preloader 所有权标记，副作用脚本不改结构）。
  - `test_game_smoke.js` 新增 4 项命名空间断言（ns.boot / ns.email / ns.room / ns.preloader），防回归。
  - 验证：`scripts_check_html.js`（25 脚本）、`test_frontend_structure.js`、`test_game_smoke.js`（39 项）、`test_ui_regression.js`、`test-all.js --quick` 全绿。
- **后续轮次完成：Active 拆分全部落地，31+31 测试每步全绿。** 新增：
  - `active/plan-domain.js`：`createPlanDomain({ getState, armedUsers, saveNow })` —— 调度计算（nextRun / 免打扰）、setting 与 AI 计划净化器、指纹 / 任务元数据 / 运行时替换与取消；PLAN_* 常量随工厂导出；
  - `active/model-client.js`：`createModelClient({ getState, trimText, finiteTimestamp, mergeRecentProactiveMessages, maxAttempts, similarityLimit })` —— 主动消息 prompt、anthropic/gemini/openai 三适配、重试与相似度校验、角色化兜底、Windows 气泡通知；
  - `active/scheduler.js`：`createScheduler(ctx)` —— executeTask / executePlan / evaluatePlan / schedulerTick（崩溃遗留回收、历史裁剪）/ startScheduler / shutdown；`ticking` 标志收进工厂闭包，`closeServer` 回调注入；顺带修复了 persistence 提取后 `shutdown` 里残留的 `saveQueued` 引用（原 `if (saveQueued) saveNow(); else saveNow();` 化简为单次 saveNow）；
  - `active/http.js`：`createHttp(ctx)` —— CORS 白名单（含 PNA 注释）、JSON 响应、请求体解析、全部 REST 路由与 `server` 实例（随工厂返回，root 的 require.main 守卫继续 listen）。
  - `active-message-service.js` 从约 2021 行降至 **268 行**：常量 / 状态与 armedUsers / 工厂装配 / require.main 守卫与模块导出。全部状态读写经 `getState()`（计划域、模型客户端、调度器、HTTP 四层一致），armedUsers / saveNow / queueSave / 计划域与模型客户端函数全部依赖注入，无循环依赖。
- **命名空间与 Active 拆分最终验证**：`node test-all.js --all` 三组全绿（static 2 项 1.4s / service 3 项 14.2s / browser 3 项 24.8s，总 40.3s）；`test_game_smoke.js` 39 项含命名空间断言。
- 后续建议（未开始）：命名空间继续迁移（local-first / local-vault / site-operations 等自包含模块 → 再按依赖顺序推进大文件）；注意每次用 edit 工具改 `InternalBeyond.html` 后复查 BOM（`encoding.bom` 断言会拦）。

### 9.16 2026-08-13 命名空间迁移 · 第二批（自包含模块）

- 本批迁移三个文件，全部测试绿色：
  - `local-first.js`（已是 IIFE）→ 加 NS 参数 + `IB.localfirst` 注册（setQuietMode / isLocalUrl / cachedLibraryStatus）；
  - `local-vault.js`（已是 IIFE，副作用模块：拦截 `window.importAll` / 包装 `loadApiSettingsUI`）→ `IB.vault` 所有权标记（format / version）；
  - `site-operations.js`（顶层脚本，350 行）→ 完整 IIFE 化 + **双挂载**：
    - 函数与常量直接挂 window（`clearAllApiKeys` / `ibToolTest` 等被 HTML 内联 `onclick` 调用；`_WS_INSTR_BLOCK` 被 workspace.js、`_IMGGEN_INSTR_BLOCK` / `_getIbToolResultInjection` / `_ibToolDrainImages` 被 communication.js 消费）；
    - 可变状态用 `Object.defineProperty` **getter/setter 转发 IIFE 局部绑定**（`_ibToolsCache` / `_ibToolPendingResults` / `_ibToolDrainImages` / `_siteCtxLastHash` / `_ibToolEditingId`）——关键：`_ibToolPendingResults` 会在出队时被**重新赋值**，普通引用挂载会造成 social.js / integrations.js 读到过期数组；`_siteCtxLastHash` 被 social.js 写回，也需要 setter。
  - `IB.ops` 注册完整导出（危险操作 / 站点上下文 / 工具目录与执行 / 注入器）。
- `test_game_smoke.js` 新增 4 项断言（ns.localfirst / ns.vault / ns.ops / ns.ops.dualAttach），现共 43 项。
- 验证：`scripts_check_html.js`（25 脚本）、`test_frontend_structure.js`、`test_game_smoke.js`（43/43）、`test_ui_regression.js`（含 vault.encryptDecryptRoundTrip、localFirst.*、runtime.noJsErrors）全绿。
- 迁移经验（后续大文件直接套用）：**每个导出的可变变量先查“是否会被本文件或其他文件重新赋值”**，被重新赋值的一律用 getter/setter 挂载；只读的 const 直接挂引用即可；被 HTML 内联 onclick 调用的函数必须保留 window 挂载。
- **大文件迁移完成（每步全套浏览器回归全绿）：**
  - `communication.js`（约 4295 行）→ IIFE 化 + 268 个名字双挂载（211 函数 / 18 const 直接挂 window；39 个 var 用 getter/setter 实时转发）+ `IB.chat` 全量注册。HTML 内联调用（`stopStreaming` / `openChatPanel` / `closeChatPanel`）与游戏模块调用（`callApiChatStream` / `callApiChat`）均经 window 桥保持。多声明行补齐 8 个名字（IMG_QUALITY / IMG_MAX_COUNT / IMG_MAX_BYTES / _vmPlayingEl / DEFAULT_READ_POSTS / DEFAULT_READ_GROUP_CHAT / DEFAULT_MEM_CONTENT_LEN / FILE_MAX_COUNT）。
  - `workspace.js`（约 3336 行）→ 200 个名字双挂载 + `IB.workspace` 注册；HTML 内联调用 `openWorkspace` / `minimizeWorkspace` / `closeWorkspace` 保持。
  - `memory.js`（约 2178 行）→ 121 个名字双挂载 + `IB.memory` 注册；HTML 内联调用 `openMemoryModal` / `renderMemories`（oninput/onchange）保持。
  - 方法论沉淀（迁移脚本可复用）：扫描列 0 声明 → 按 kind 分类 → 函数/const 平挂、var/let 用 `Object.defineProperty` getter/setter 转发 IIFE 局部绑定 → `NS.expose` 全量注册；多声明行逐一人工核对补齐；迁移前检查 `NS` 标识符与 helper 名冲突（本轮三文件均为 0）。
- `test_game_smoke.js` 新增 6 项断言（ns.chat / ns.chat.dualAttach / ns.workspace / ns.workspace.dualAttach / ns.memory / ns.memory.dualAttach），现共 49 项。
- **最终验证**：`node test-all.js --all` 三组全绿（static 2 项 1.6s / service 3 项 16.6s / browser 3 项 25.7s，总 43.9s）。
- **迁移全部完成（2026-08-13 后续轮次）：**
  - IIFE 标记迁移：`glass-canvas.js`（IB.glassCanvas）、`glass-ripple.js`（IB.glassRipple）、`memory-sky.js`（IB.memorySky，暴露 build/play/pause）、`bridge.js`（IB.bridge）、`calendar.js`（IB.calendar）——它们本来就是自包含 IIFE，只加 `NS` 参数与所有权标记。
  - 全量双挂载迁移：`core.js`（IB.core，153 名字，含 `db` / `playlist` / `_ibFsDirty` 等热变量 getter/setter 挂载）、`social.js`（IB.social，150 名字，含 `apiConfigs`）、`integrations.js`（IB.ext，9 名字：IBNET / IBMCP / IBFC / IBWS / IBSandbox / IBDIY / ibExtSay / ibExtReset / IB_MD）、`active-diary.js`（IB.active，148 名字）、`game/` 六文件（IB.game 合并注册，202 名字）。
  - **踩坑记录**：
    1. `calendar.js` 初看像顶层脚本（内部代码列 0 缩进、扫描器把 IIFE 内部声明当成了顶层），实际整个文件外包了 IIFE——第一版误加外层包裹导致 attach 块 `$ is not defined`，被 `runtime.noGameExceptions` / `runtime.noJsErrors` 当场抓出。已回滚为标记迁移。**教训：批量迁移前先确认文件是否已有 IIFE 包裹（看文件头是否有 `(function(){`）**。
    2. game 六文件带有顶层 `'use strict'`：IIFE 开括号必须插在文件头注释**之前**，保持 strict 指令的序言位置（注释允许出现在指令前），否则严格模式语义丢失。
    3. PowerShell 字符串拼接的引号/插值坑（`$n:` 需要 `${n}`、单引号转义、JS 模板字符串与 pwsh 反引号冲突）——迁移脚本已沉淀为可复用函数。
  - `test_game_smoke.js` 最终 **56 项断言**（新增 ns.social / ns.ext / ns.calendar / ns.active / ns.game / ns.game.dualAttach 等）。
  - **最终验证**：`node test-all.js --all` 三组全绿（static 2 项 1.5s / service 3 项 18.6s / browser 3 项 25.1s，总 45.2s）；25 个本地脚本语法零失败；`runtime.noJsErrors` 与 `runtime.noGameExceptions` 均为 0。
- **命名空间迁移收官**：全部 `assets/js/*.js`（21 个文件）与 `game/*.js`（6 个文件）均已注册到 `window.IB`，双挂载过渡机制完整保留（HTML 内联 onclick、跨文件全局调用全部经 window 桥）。后续若要收紧：可逐步删除 window 挂载（每删一个跑全套浏览器回归），或维持双挂载作为兼容层。

### 9.17 2026-08-13 chat 冒烟测试（communication 拆分前的安全网）

- 新增 `test_chat_smoke.js`（零依赖 CDP + 本地 mock OpenAI 端点，19 项断言），已接入 `test-all.js` browser 组（现共 10 个入口）：
  - 真实发送链路：mock 端点 ← `sendChatMessage` → `callApiChat` → 回复渲染 + 落库（user/assistant 两条消息）；
  - 信件：落库 → `loadLetters` 渲染卡片 → `openLetter` → `deleteLetter`；
  - 批注：`_annoPickAI('id')` 打开输入条 → 填写 → `_annoSend`（mock 模型）→ `blogAnnotations` 落库；
  - 摘要设置：DOM 表单（`#api-summary-toggle`）→ `saveSummarySettings` → `getSummarySettings` 往返；
  - window 与 `IB.chat` 双挂载抽样；全程 `Runtime.exceptionThrown` 捕获（0 异常）。
- **测试经验（重要）**：
  1. `openChatPanel()` 会经 `renderChatPanelFriends → loadApiConfigs` 从 IndexedDB **重载 apiConfigs**——直接 `apiConfigs.push()` 的测试配置会被冲掉。正确做法：`dbPut('apiConfigs', cfg)` 落库 → `loadApiConfigs()` → 再设 `activeFriendId`。
  2. headless 下 `confirm()` 永久阻塞 CDP 调用（`deleteLetter` 会弹确认）——测试开始时统一 `window.confirm=()=>true`。
  3. 迷你面板消息容器是 `#chat-messages`（`currentPage==='chat'` 时才是 `#chat-full-messages`）；断言用 `textContent` 而非 `innerText`（隐藏元素不在 innerText 里）。
- 验证：`test_chat_smoke.js` 19/19、`test-all.js --all` 三组全绿（static 2 / service 4 / browser 4，45.9s）。
- **letters 提取完成（机械迁移，只动位置不改逻辑）：**
  - 新增 `assets/js/communication/letters.js`（362 行）：LETTERS 区段原样迁入（邮票/信封 SVG、Demo 信、loadLetters / openLetter / closeLetter / filterLetters / requestLetterFromSelected / deleteLetter / exportLetters 等 20 个名字），IIFE 私有作用域 + window 双挂载 + `IB.chat.letters` 注册；在 communication.js 之前加载（letters 顶层无可执行语句，跨文件调用全在运行时，顺序安全）。
  - `communication.js` 从 4840 行降至约 4620 行，attach/expose 块中 letters 名字全部移除（正则按名字剔除 41 行）。
  - **踩坑**：切片时误把 communication.js 自己的 IIFE 开括号 `(function(NS){` 一并删掉（RemoveRange 覆盖了第 3 行），语法检查报末尾 `Unexpected token '}'`；补回两行头后恢复。**教训：切片边界要先把目标文件的包裹行排除在删除范围外。**
  - `test_chat_smoke.js` 的 dual.letters 断言更新为 `IB.chat.letters.*`。
  - 验证：`test_chat_smoke.js` 19/19、`test-all.js --all` 三组全绿（static 2 / service 4 / browser 4，46.2s）、26 个本地脚本语法零失败。
- **voice / annotations 提取完成（按 Codex 顺序：voice 先、annotations 次）：**
  - `assets/js/communication/voice.js`（511 行）：VOICE MESSAGE SYSTEM 全域（_vm* / _vt* / _buildVoiceEl / _vmTogglePlay，24 函数 + VM_MAX_SEC + 7 可变状态）→ `IB.chat.voice`，window 双挂载。外部消费者（social.js:682 loadVoiceTransUI、active-diary.js:1893 _vmInit、memory.js:1751 _vmStopForMsgIds）与内部延迟回调（appendChatBubble 模板串 onclick=_vmTogglePlay、sendChatMessage 的 _vmAudioNative/_vtGet）全部经 window 桥保持。
  - `assets/js/communication/annotations.js`（306 行）：BLOG ANNOTATIONS 全域（toolbar 挂载 IIFE + 三个 document 级监听 + 14 函数 + 5 可变状态）→ `IB.chat.annotations`。core.js 的运行时调用（_annoHideAll / _renderAnnotationsForPost / _annoEnrichPostCards）经 window 桥保持。
  - **区域限定的名字剔除**（本次新教训）：letters 那次按名字全局剔除是安全的（无内部消费者）；voice/annotations 在 communication.js 内还有代码行引用（`_buildVoiceEl(m.voice)`、`_voiceApiLine` 等），剔除必须只作用于双挂载标记行之后——脚本从 attach 标记行起才按名字过滤。
  - `test_chat_smoke.js` 增至 **28 项**：voice 7 项 mock 行为断言（_vmSupported / _vmRecogErrMsg / _voiceApiLine / _buildVoiceEl / _vmTogglePlay 状态机 / _vmInit 无麦克风优雅降级 / 双挂载）；annotations 补 anno.close + anno.rerenderPersists（关闭输入条、重渲染后批注仍在）。
  - **结构测试固化**（Codex 建议落地）：`test_frontend_structure.js` 新增 com.* 断言——communication.js 与每个 communication/*.js 子模块必须含 `(function(NS){` 与 `})(window.IB || (window.IB = {}));`（切片误删 IIFE 开括号会立即给出明确失败原因），且每个子模块独立 `node --check`。**注意：此处用 includes 而非正则——三层转义（run_code 模板 / write / pwsh）把正则搞得不可靠，includes 零转义更稳。**
  - 验证：`test_chat_smoke.js` 28/28、`test-all.js --all` 三组全绿（46.1s）、28 个本地脚本语法零失败。
- **summary 提取完成（communication.js 拆分收官）：**
  - `assets/js/communication/summary.js`（244 行）：CONVERSATION SUMMARY SYSTEM 全域（getSummarySettings / saveSummarySettings / loadSummarySettingsUI / renderSummaryMgmt / toggleSummaryDetail / deleteSingleSummary / getChatSummary / saveChatSummary / generateSummary / maybeSummarize / _doSummarize / autoSummaryOnOpen / _getSummaryTriggerCount + SUMMARY_TRIGGER_COUNT / SUMMARY_WINDOW_LIMITS / _summarizing）→ `IB.chat.summary`。外部消费者 social.js（loadSummarySettingsUI:682、autoSummaryOnOpen:764/1144/1221）与发送路径内部调用（getSummarySettings / maybeSummarize / getChatSummary）全部经 window 桥保持。
  - `communication.js` 降至约 3600 行（原始 4840）；`assets/js/communication/` 下四个子模块（letters 362 / voice 511 / annotations 306 / summary 244）全部 IIFE + 双挂载 + 独立 node --check（结构测试 com.* 断言兜底）。
  - `test_chat_smoke.js` 增至 **31 项**：summary.saveGet（saveChatSummary 位置参数往返）与 summary.generate（mock 模型真实 generateSummary 链路，返回文本含 mock 字样）。测试经验：`saveChatSummary(friendId, threadId, summary, coveredUpTo, …)` 是位置参数；`generateSummary(cfg, prevSummary, newMessages, charLimit, names)` 收 cfg 与新消息数组而非 friendId——按真实签名调用。
  - 验证：`test_chat_smoke.js` 31/31、`test-all.js --all` 三组全绿（45.5s）、29 个本地脚本语法零失败。
- **workspace 冒烟测试落地（拆分前安全网，Codex 顺序第一步）：**
  - 新增 `test_workspace_smoke.js`（28 项，零依赖 CDP，无需 mock 端点——文件操作与 JS 沙箱全本地），已接入 `test-all.js` browser 组（现共 11 个入口）：
    - 默认/User 项目初始化（wsEnsureDefaultProject / wsEnsureUserProject）；
    - 项目创建/重命名/删除 + 默认项目不可删（wsCreateProject / wsRenameProject / wsDeleteProject 的守卫）；
    - 文件创建/同路径覆盖/重名保护（_wsUniquePath → 「名 (2).ext」）/导入（_icodeCollectFlatFiles + _icodeDoImport）/持久化重载（wsGetFiles 回读）；
    - 预览：renderWsFiles 行渲染 + wsTogglePreview 文本预览（行号+内容）与开关往返、HTML 预览渲染按钮、富文件分派助手（_icodeIsText/_icodeIsRich/_wsRichKind/_wsRichMime/_icodeLooksBinary）；
    - JS 沙箱：成功（console.log 输出回传）、异常（errText 含错误信息）、超时（timedOut:true，400ms 定时终止 while(true) Worker）；
    - AI 工作区指令：_parseWsOps 解析 `<ws_create>`、_execWsOps 成功落库、失败（ws_read 缺失文件）经 _getWsOpFeedbackInjection 闭环反馈；
    - window 与 IB.workspace.* 双挂载；全程 0 未捕获异常。
  - **测试经验**：`_wsRunJs(code, entry, files, timeout)` 的 entry 非空时 worker 会校验 `files[entry]` 存在（内联代码要传 `entry:''`）；`_parseWsOps` 返回 `{cleanText, ops, files}` 对象而非数组；AI 指令串断言避免在 evaluate 表达式里写真实换行（三层转义陷阱）。
  - 验证：`test_workspace_smoke.js` 28/28、`test-all.js --all` 三组全绿（47.6s）。
- **workspace/preview.js 提取完成（两个 chunk 机械迁移）：**
  - `assets/js/workspace/preview.js`（884 行，47 函数 + 10 状态）：chunk A=富文件支持（二进制嗅探 / 解析库 IndexedDB 缓存 / PDF·DOCX·XLSX·PPTX·RTF·EPUB 提取 / ZIP 只读工具 / PDF 密码会话缓存），chunk B=预览面板 UI（wsTogglePreview / _wsOpenRichPreview / 渲染与文本视图切换 / 搜索 / 预览内编辑）。`IB.workspace.preview` 注册。
  - **审计结论**：外部仅只读运行时调用（communication.js pickFile 的 `_icodeIsRich`/`_wsFileToDataUrl`/`_wsExtractRichText`、local-first.js 的 `_ibLibClear`），无跨文件写入；延迟引用为预览面板模板串的内联 onclick（随 chunk 迁移，经 window 桥解析）。
  - `workspace.js` 从约 3380 行降至约 2913 行；`_icodeIsText`/`_ICODE_TEXT_EXT` 等导入域助手留在父文件（files 域，最后拆）。
  - 结构测试扩展 ws.* 断言（workspace/ 子模块 IIFE 首尾 + 独立 node --check，与 com.* 同法）。
  - 验证：`test_workspace_smoke.js` 28/28（dual.preview 更新为 IB.workspace.preview.*）、`test-all.js --all` 三组全绿（46.3s）、30 个本地脚本语法零失败。
- **workspace/run.js 提取完成：**
  - `assets/js/workspace/run.js`（308 行，13 函数 + 9 状态）：ws_run 全域（JS 一次性 Worker / Pyodide 常驻 Worker 源码、超时强杀、写回项目、输出回注队列、询问模式待运行卡、预览面板手动运行）→ `IB.workspace.run`。
  - **审计结论**：外部消费者——communication.js 发送路径 `_getWsRunOutputInjection`（1367/1666）、父文件卡片模板内联 onclick（`_wsConfirmRunFromCard` 509、`wsRunFileFromUI` 2410）均为运行时/延迟解析，经 window 桥保持；integrations.js 里 `_WS_*_WORKER_SRC` 的命中只是注释提及（false positive，实际拼接发生在 run 域内部运行时）。
  - `workspace.js` 降至约 2615 行；`test_workspace_smoke.js` 的 dual.run 更新为 `IB.workspace.run.*`。
  - 验证：`test_workspace_smoke.js` 28/28、`test-all.js --all` 三组全绿（46.2s）、31 个本地脚本语法零失败、结构测试 ws.* 断言全绿。
- **workspace/files.js 提取完成（四段机械迁移，Workspace 拆分收官）：**
  - `assets/js/workspace/files.js`（1366 行，61 函数 + 14 状态）：C1 状态与项目/文件 CRUD（_wsActiveProject / _wsPendingReads / _wsPendingOpFeedback / _wsViewingProject + 默认/User 项目 + 上传归档 + wsSaveFile/_wsUniquePath 重名保护），C2 _wsResolveProject 项目回退解析，C3 导入管线（ICODE_IMP 限额 / 文本扩展名 / ZIP 解包 / 文件选择器与确认对话框），C4 文件列表 UI 与行操作（wsRenameProject / renderWsProjects / renderWsFiles / 拖到聊天 / 下载 / 删除确认 / 移动复制）。`IB.workspace.files` 注册，加载顺序：files → preview → run → workspace.js。
  - **审计结论**：外部读写均为运行时——communication.js（_wsArchiveUserUploads / _wsArchiveFileBlocks / _wsPendingReads）、site-operations.js（_wsPendingOpFeedback）、HTML 内联 onclick（wsPickImport）；子模块间依赖（run.js/preview.js 调 wsGetFiles/wsSaveFile/renderWsFiles）经 window 桥保持。父文件残留引用全部是 AI 操作执行与操作卡模板的运行时代码调用，无悬空挂载。
  - **Workspace 拆分收官**：workspace.js 从约 3380 行降至 **1259 行**（协调层：AI 操作解析/执行/卡片/流式注入/反馈/空头支票检测/博客阅读/存储条/窗口骨架/docx·pdf·xlsx 生成器/解析库目录）；`assets/js/workspace/` 三子模块（files 1366 / preview 884 / run 308）。
  - `test_workspace_smoke.js` 的 dual.basic 更新为 `IB.workspace.files.*`。
  - 验证：`test_workspace_smoke.js` 28/28、`test-all.js --all` 三组全绿（47.0s）、32 个本地脚本语法零失败、结构测试 ws.* 断言全绿。
- **Memory 冒烟测试落地（拆分前安全网，23 项，零依赖 CDP + 可切换 mock 端点）：**
  - 已接入 `test-all.js` browser 组（现共 12 个入口，50.4s 全绿）。覆盖：
    - 记忆增删改与持久化重载（quickCreateMemory / toggleMemPin / toggleMemResolved / deleteMemory / dbGet 回读）；
    - Auto Memory mock 模型生成 → parseMemoryCandidateResponse 解析 → 审批队列（_memoryApprovalActive 槽位）→ _resolveMemoryApproval(true) 落库；_memoryRepeatCount 去重；mock 500 失败降级不落库不抛错；
    - 记忆注入聊天上下文（getMemoryContext 返回含记忆标题的字符串）；
    - 星座数据生成与重渲染（stub `#mem-sky-lines` SVG → _memSkyConstellations 邻近点连线 / 远点零线重渲）——与 memory-sky.js 画布星场明确区分；
    - 空数据渲染与损坏记录（title:null/content:123）评分与渲染不抛错；
    - 跨模块状态同步（_amUserName 读 communication 的 _cachedUserName getter 桥）；
    - window 与 IB.memory.* 双挂载；全程 0 未捕获异常。
  - **测试经验**：`_generateMemoryCore` 会挂起在审批 Promise 上——evaluate 需 fire-and-forget（IIFE 立即返回 true），再 waitFor 审批槽位（`_memoryApprovalQueue.length>=1 || _memoryApprovalActive!==null`，首个候选走 active 槽而非队列）。
- 下一步（既定路线）：提取 memory/auto-memory.js（_am* / am* 域）→ memory/constellations.js（_memSkyConstellations 星座数据层，避免与 memory-sky.js 画布星场混淆），memory.js 保留为记忆 CRUD / 上下文注入 / 协调层；最后 active-diary.js。

### 9.18 2026-08-14 Memory 拆分完成（auto-memory / constellations）+ 一次数据恢复

- **auto-memory 提取**：`assets/js/memory/auto-memory.js`（555 行机械迁移，IIFE 包裹 + 双挂载 + `NS.expose('memory.autoMem', ...)`）。
  - 域内容：AM 写入标签协议与注入块（_amInstrBlock / _amFmtEntry / _amScore / _amRecordOnlyBlock / amBuildInject）、候选解析（_parseMemOps / _memoryJsonObject / _memoryReasons / _memoryScore / _autoMemCandidatePayload / _memoryRepeatCount / _calibrateMemoryCandidate）、审批 UI（requestMemoryApproval / _showNextMemoryApproval / _resolveMemoryApproval / _execMemOps）、展区与条目 CRUD（_amBuildSearchCard / _amBuildMemCard / _amCoreHtml / _amTrayHtml / renderAutoMemShowcase / amStep / amEditEntry / amSaveEntry / amDeleteEntry）、按天记录管理（_amDayKey / _amMsgsOfDay / renderApiDayList / apiExportDay / apiDeleteDay）。
  - 可变状态经自有桥 `ibAmLive`（getter/setter 双向往返）：_memoryApprovalQueue / _memoryApprovalActive / _amIdx / _amArchMode / _amSeq / _amExpandPersona / _amQuoteFor；常量 AM_CATS / AM_PRIOS 随域迁移。
- **constellations 提取**：`assets/js/memory/constellations.js`（104 行）：getMemVitality / buildMemorySky / _jitter / _memSkyConstellations / shuffleMemoryQuote，`NS.expose('memory.constellations', ...)`。注意 shuffleMemoryQuote 跨模块读 `_amList()`/`_amIdx`（window 运行时桥，保持可用）。
- **外部消费者审计（全通过）**：communication.js + letters.js 的 amEnabled/amBuildInject/_parseMemOps/_execMemOps；core.js 的 renderAutoMemShowcase；HTML 内联 onclick（toggleAmArchive/amStep/apiToggleDays/toggleSummaryMgmt/shuffleMemoryQuote/amRecPillClick/amJumpSettings）——全部经 window 双挂载保持。
- **memory.js 从 2477 行降至 1704 行**（协调层：评分/可见性/记忆 CRUD/模态/上下文注入/生成流/聊天选择/封存/仪表盘/导出/画布特效 + IB.memory 注册）。
- `test_frontend_structure.js` 新增 mem.* 断言（memory/ 子模块 IIFE 首尾 + 独立 node --check）；`test_memory_smoke.js` 的 dual.autoMem/dual.sky 更新为 `IB.memory.autoMem.*` / `IB.memory.constellations.*`，am 配置写入改为 async+await（消除未 await 的时序竞态）。
- 验证：`test_memory_smoke.js` 23/23、`test-all.js --all` 三组全绿（12 入口，51.6s）、34 个本地脚本语法零失败。

### ⚠ 9.18 事故记录（重要教训：提取脚本的失败原子性）

- **事故**：首次提取时 Node 脚本先改写 memory.js（切块 + 区域限定的 attach/expose 剔除成功执行），随后写 `assets/js/memory/auto-memory.js` 时因目录不存在抛 ENOENT——切块内容只存在于进程内存，随失败丢失；git 无 assets（未跟踪）、无其它备份，自动恢复一度无解。
- **恢复路径（成功）**：
  1. DSH 会话转录（`%USERPROFILE%\.dsh\sessions\...\session.jsonl.zstd`）——zstd 帧格式可手工解析（node:zlib zstdDecompressSync），从历史 read 工具结果回读 memory.js 片段（524 行 + attach 块 2229-2476 全量）；
  2. **Cursor 本地 AI 记录（决定性）**：`%APPDATA%\Cursor\User\globalStorage\state.vscdb` 的 cursorDiskKV 表中 composer.content / inlineDiffUndoRedo 记录内含 memory.js 全文件（迁移前版本）——与磁盘保留行逐行比对（1544 行仅 5 处已知差异 = 后加的 `_ibApiHasCredential`/`_ibApiReady` 重构，均在保留区）；
  3. 重组：磁盘保留行 + 游标版切块 + 转录版 attach 块 ⇒ 与全部 524 个已知行 100% 一致、2477 行、node --check 通过；恢复后重新执行提取。
- **流程教训（已固化）**：提取脚本必须 (1) 先 mkdir；(2) 先写新模块文件、最后再改父文件；(3) 父文件改写前留存完整备份（本次 `.dsh-recovery/restored-memory.js`）；(4) 任何批量改写前确认 git 或外部介质有可回退副本。

- 下一步（既定路线）：最后拆分 active-diary.js（active-plans / diary，最高风险，最后做）。

### 9.19 2026-08-14 Active / Diary 前端拆分完成

- **拆分前安全网**：新增 `test_active_diary_smoke.js`（19 项）并接入 `test-all.js` browser 组。覆盖计划偏好、JSON 解析与校验、同 ID 替换、渲染、用户回复取消，以及日记偏好、JSON/纯文本解析、mock 模型生成、持久化、去重、渲染和删除；同时检查 window / `IB.active.plans` / `IB.active.diary` 双挂载与页面零未捕获异常。
- **失败原子性**：改写前把完整 `active-diary.js` 存为 Git blob `e0f151bbf9e11722186117f6c99903eac3ecc197`；先创建并独立 `node --check` 两个子模块，最后才替换父文件。第一次预检因临时文件使用未知 `.next` 扩展被 Node 24 拒绝，父文件尚未改写；改用 `.next.js` 后完成预检与替换。
- **active-plans 提取**：`assets/js/active-diary/active-plans.js`（949 行），包含 AI 主动计划偏好、计划生成/解析/校验/持久化/渲染/执行与用户回复取消逻辑；window 兼容桥保留，注册到 `IB.active.plans`。
- **diary 提取**：`assets/js/active-diary/diary.js`（457 行），包含角色日记偏好、生成解析、去重、持久化、渲染与删除；window 兼容桥保留，注册到 `IB.active.diary`。
- **父协调层**：`assets/js/active-diary.js` 从约 2235 行降至 843 行，保留主动消息基础调度、初始化、主题与总协调逻辑。HTML 加载顺序固定为 `active-plans.js` → `diary.js` → `active-diary.js`。
- **结构加固**：`test_frontend_structure.js` 新增 active.* 的父/子 IIFE 首尾和子模块独立语法断言；旧版 blob 与拆分后三文件的顶层声明集合核对为 143 → 143，零缺失。
- **最终验证**：`test_active_diary_smoke.js` 19/19；`test-all.js --all` 共 13 个入口全绿（static 2 / service 4 / browser 7，67.0s）；HTML 引用的 36 个本地脚本语法零失败。
