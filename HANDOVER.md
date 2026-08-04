# Internal Beyond · 交接文档

> 写给下一个对话：先读这份文档，再读代码。本对话时间为 2026-08-04，主题是给 Internal Beyond 补一个“本地 Bridge 后端”并接入前端。

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
| `test_bridge.js` | 后端冒烟/功能测试（67 项断言，零依赖） |
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
node test_bridge.js        # 67 项，exit 0
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
