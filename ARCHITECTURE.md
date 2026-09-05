# Internal Beyond · 架构文档

> 本文档回答「这个项目是怎么工作的」。历史演进见 [CHANGELOG.md](CHANGELOG.md)，设计理由见 [DECISIONS.md](DECISIONS.md)，踩坑见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 1. 总览

Internal Beyond 是一个**个人本地 AI 陪伴站**：入口是 [InternalBeyond.html](InternalBeyond.html)，配套两个本地 Node 服务：

| 组件 | 端口 | 入口脚本 | 职责 |
|---|---|---|---|
| 主站（浏览器） | — | 直接打开 `InternalBeyond.html`（`file://`） | 主聊天（浏览器直连各家 AI API）、社交圈、日记、记忆、工作区、游戏等全部页面功能 |
| Bridge 后端 | `127.0.0.1:23115` | `start-bridge-service.cmd` → [ib-bridge-service.js](ib-bridge-service.js) | 表情包、心语墙、健康/定位/天气看板、酷狗点歌、Bark/ntfy 推送、上下文进度条、`/continue` 续写、AI 常驻会话（多模型）、TTS 语音气泡、多窗口同步 |
| Active companion | `127.0.0.1:23114` | `start-active-service.cmd` / `start-local-services.cmd` → [active-message-service.js](active-message-service.js) | 浏览器关闭后的后台执行：主动消息计划（plans）、朋友圈调度（moments）、AI↔AI 回复链续推、事件回传 |

- **无构建步骤**：全部是原生经典脚本，HTML 按固定顺序 `<script>` 加载；直接打开 HTML 的启动方式不变。
- Bridge 纯 Node 内置模块零依赖（Node 18+）；WebSocket 为手写 RFC6455 实现。
- 主聊天仍由浏览器直连各家 API；Bridge 不做主聊天代理。AI 常驻会话是独立于主聊天的一套。

可用环境变量覆盖服务参数：`IB_BRIDGE_PORT` / `IB_BRIDGE_HOST` / `IB_BRIDGE_DATA_DIR`、`IB_RESIDENT_TICK_MS`（Bridge 定时扫描间隔）、`IB_ACTIVE_DATA_DIR`（companion 数据目录，测试用）、`IB_SOCIAL_OBSERVE=off`（关闭观测持久化）。

## 2. 目录与模块结构

```
InternalBeyond/  # 仓库根目录
├── InternalBeyond.html          # 入口 HTML（页内仍有少量内联脚本与全部页面 DOM）
├── ib-bridge-service.js         # Bridge composition root（约 998 行）
├── bridge/                      # Bridge 七个 CommonJS 工厂模块
│   ├── util.js                  # deepMerge / backupBrokenFile / uid / todayStr / constantTimeTokenMatch / parseQuery
│   ├── config.js                # createConfig({dataDir, writeJson})：config/configRaw/configInvalid/LAN_EXPOSED/鉴权辅助
│   ├── clients.js               # createClients({config, getGeoLatest})：天气(wttr.in)、网易云/酷狗、Bark/ntfy
│   ├── tts.js                   # createTts({config, uid, ttsDir})：Edge 免费 TTS + OpenAI 兼容 TTS
│   ├── persistence.js           # createPersistence({dataDir})：jsonPath/writeJson/saveJson/loadJson/loadList/...
│   ├── ws.js                    # createWs({...})：心跳/recordPush/broadcast/WSConnection
│   └── routes.js                # createRoutes(ctx)：CORS/rateCheck/readBody/diagnostics/handleHttp
├── active-message-service.js    # companion composition root（约 268 行，require.main 守卫自启）
├── active/                      # companion 五个域模块（CommonJS 工厂 + 依赖注入）
│   ├── persistence.js           # 状态加载(主→.tmp→.bak)/原子写(tmp+fsync+备份轮换)/50ms 合并保存队列
│   ├── plan-domain.js           # 调度计算(nextRun/免打扰)、setting 与 AI 计划净化器、指纹/替换/取消
│   ├── model-client.js          # 主动消息 prompt、anthropic/gemini/openai 三适配、重试与相似度校验、Windows 气泡通知
│   ├── scheduler.js             # executeTask/executePlan/evaluatePlan/schedulerTick/startScheduler/shutdown
│   ├── http.js                  # CORS 白名单(含 PNA 注释)、JSON 响应、全部 REST 路由与 server 实例
│   └── moments.js               # 朋友圈后台域：sanitizeMomentSchedule/parseMomentOutput/executeMomentSchedule/
│                                #   reply-chain 域(syncReplyChainThreads/maybeCreateReplyTask/executeReplyChainTask/
│                                #   replyChainCrashRecover/replyChainPrune)
├── assets/css/                  # core.css(基础主题前 383 行) + core/ 12 段(chat-shell/letters/memory/pages/chat/
│                                #   workspace/api-components/blog/about/widgets/archive-active) +
│                                #   calendar.css / bridge.css / moments.css / social.css
├── assets/js/                   # 前端模块（见 §3）
│   ├── core.js communication.js workspace.js memory.js active-diary.js social.js integrations.js ...
│   ├── communication/{letters,voice,annotations,summary}.js
│   ├── workspace/{files,preview,run}.js
│   ├── memory/{auto-memory,constellations}.js
│   ├── active-diary/{active-plans,diary}.js
│   ├── moments.js social-network.js reply-chain-core.js social-observe.js
│   ├── ib-namespace.js local-first.js local-vault.js site-operations.js bridge.js calendar.js preloader.js ...
│   └── game 六文件在 game/ 下（见 §8）
├── game/                        # game_module.js / game_tarot.js / game_story.js / game_dialogue.js / game_room.js / game_tea.js
├── test-all.js                  # 统一测试入口（--quick / --browser / --all）
├── test_*.js                    # 各冒烟/单元/集成套件（见 §10）
└── scripts_check_html.js        # 提取 HTML 内全部 <script> 块逐个 node --check
```

### HTML 加载顺序（关键约束）

1. `assets/js/ib-namespace.js` **最先**（创建 `window.IB` 与 `IB.section/expose`）；
2. 其余 assets 脚本按原语句顺序加载（core → communication(+communication/*) → workspace(+workspace/*) → memory(+memory/*) → social → moments 相关：`reply-chain-core.js` 在 `moments.js` 之前 → `social-network.js` → active-diary（`active-plans.js` → `diary.js` → `active-diary.js`）→ integrations → bridge → calendar → game 六文件（在 `assets/js/calendar.js` 之后、`room-integration.js` 之前）→ …）；
3. CSS 以原始区段顺序加载：core.css 之后按序加载 `core/` 12 段（顺序断言由结构测试固化），再 moments.css / social.css 等。

前端拆分文件统一为 **UTF-8 BOM**（`.editorconfig` 已配置）；`test_frontend_structure.js` 的 `encoding.bom.*` 断言会拦截丢 BOM 的文件。

## 3. 前端架构

### window.IB 命名空间与双挂载

- `ib-namespace.js` 提供 `window.IB`、`IB.section('chat.letters')` 自动建链、`IB.expose(name, exports)` 幂等合并注册。
- 全部 `assets/js/*.js`（21 个文件）与 `game/*.js`（6 个文件）均已注册到 `window.IB`（如 `IB.chat` / `IB.workspace` / `IB.memory` / `IB.active` / `IB.moments` / `IB.socialnet` / `IB.game` / `IB.ops` / `IB.ext` / `IB.core` / `IB.social` …）。
- **双挂载过渡机制完整保留**：函数/const 直接挂 window；会被重新赋值的 var/let 用 `Object.defineProperty` getter/setter 实时转发 IIFE 局部绑定；被 HTML 内联 `onclick` 调用的函数必须保留 window 挂载。跨文件调用全部经 window 桥。
- 子模块统一 IIFE 包裹：`(function(NS){ ... })(window.IB || (window.IB = {}));`——结构测试 com.*/ws.*/mem.*/active.* 断言首尾标记与独立语法。

### 设计变量体系

全局语义设计变量（surface / content / border / focus / shadow / radius / motion / font / spacing / status），Light 与 `body.theme-infernal` 分别覆写；Bridge 工具箱、Moments、Social Net 复用同一套变量。静态 HTML 内联 style 预算 ≤200 处（运行状态/动态几何值除外），由结构测试把关。

### 关键包装器（依赖全局函数，勿改名）

`window._tkRecord`、`window._assistantResponseParts`、`window.sendChatMessage`、`window.dbPut`、`window.ibMusicPlay`、`window.ibBridgeBase`。

- 上下文进度条：Chat 顶部，70% 橙、85% 红；优先服务端 `/api/context`，离线用 localStorage 估算。
- `/continue`：包装 `_assistantResponseParts`，仅当未达上限（2 次）时剥离标记并自动续写；达到上限保留标记；新用户消息重置计数（包装 `sendChatMessage`）。附件保护：自动续写时保存/清空/还原 `_pendingImages/_pendingFiles` 并重绘预览。
- 多窗口同步：包装 `dbPut`（chatMessages 写入后写 localStorage `ib_chat_sync`），其他标签页 `storage` 事件防抖重载聊天。
- 表情：AI 消息里 `[sticker:名字]` 渲染成图（png→svg 失败回退，防重入）；音乐 `[music:ID|歌名]` 渲染为按钮走 `/api/music/open`。
- TTS：AI 气泡上「🔊 朗读」→ `/api/tts` 生成语音条（播放/暂停/时长，全局互斥 `_ibTtsAudio`）；未配置时浏览器 `speechSynthesis` 兜底（`ibTtsFallback`）。
- 重复初始化保护：`ibBoot` 计数守卫（`window.__ibBootCount`）；包装器有效性标记 `data-ib-wrapped` / `data-ib-wrapped-db`（无头测试用）。
- Bridge 面板（右下角 FAB，位置记忆 `ib_bridge_fab_pos`）：4 页签 = 心语墙（写/删/PATCH 改）/ 生活看板（定位、天气、近 7 天健康、推送测试）/ AI 常驻（模型下拉从 `apiConfigs`+`PROVIDERS` 推导 format、会话管理、让TA主动说、自动朗读、上次会话恢复）/ 状态（服务与数据统计、最近推送、Android/OPPO 提示、数据目录）。
- 无障碍：导航链接补齐 `href`/键盘行为/`aria-current`；Bridge 为 non-modal dialog 语义、焦点回收、页签方向键、`inert`/`aria-hidden`；Skip Link 与 reduced-motion。
- 性能：页面后台时暂停雨效、音频可视化、Bridge 轮询与 Calendar 高频读数；移除重复 Cloudflare beacon。

## 4. Bridge 后端（23115）

### 基本参数

- 默认监听 `127.0.0.1:23115`；`config.json` 里 `lan: true` 改为监听 `0.0.0.0` 并打印局域网地址。
- `ib-bridge-service.js` 是纯 composition root（常量 / 业务状态与锁 / 表情 / 工具目录与 executeTool / AI 常驻引擎 / 低频主动消息 / 服务器启动与升级握手）；bridge/ 下 7 个 CommonJS 模块全部私有作用域 + 显式接口，依赖一律经工厂参数注入，无循环依赖。

### WebSocket 协议（与页面 IBNET 客户端兼容）

- 握手：`hello {client, version, token, capabilities}` → `hello_ack {ok, server, tools}`
- `ping/pong`；`tool_catalog_request` → `tool_catalog`
- `tool_call {id, name, args}` → `tool_result {id, ok, text, data, images}`
- 服务端主动 `push {title, text, from}`
- 鉴权失败 close `4401`；Origin 非法（升级时校验）返回 HTTP 403；协议错误 close `1002`
- CORS 白名单：`null`（file://）、localhost、127.0.0.1、::1；其余 Origin 一律不带 ACAO 头

### WS 工具清单（26 个，暴露给 AI）

`echo`、`sticker_list`、`whispers_read/write/delete/update`、`health_read`、`geo_read`、`weather`、`music_search`、`music_url`、`webhook`、`bark_push`、`ntfy_push`、`tts_speak`、`push_send`、`letter_write/list`、`session_get/save`、`context_stats`、`pay_register_checkout`、`submit_payment`、`pay_request_confirm`、`pay_get_config`、`pay_set_config`

### REST 接口（分组）

- 健康/状态：`GET /health`、`GET /status`、`GET /api/tools`、`GET /api/config`（敏感值脱敏 `***`）
- 表情：`GET /stickers`、`GET /stickers/<file>`（路径穿越防护）
- 心语：`GET/POST /api/whispers`、`PATCH/DELETE /api/whispers/:id`
- 健康：`GET/POST /api/health`（metrics 严格校验，非对象安全兼容）
- 地理：`POST /api/geo`、`GET /api/geo/latest`；天气：`GET /api/weather?city=`
- 音乐：`GET /api/music/search|url|open|play`
- 信件：`GET/POST /api/letters`、`DELETE /api/letters/:id`
- 会话：`GET/POST/DELETE /api/sessions/:key`；上下文：`GET/POST /api/context?friend=`
- 推送：`POST /api/push`、`GET /api/push/history`
- TTS：`POST /api/tts`、`GET /tts/<id>.mp3`
- AI 常驻：`GET/POST /api/ai/sessions`、`GET/DELETE /api/ai/sessions/:key`、`POST /api/ai/chat`、`POST /api/ai/proactive`

### AI 常驻引擎

- 会话存 `resident.json`，支持 `openai` / `anthropic` / `gemini` 三种格式（由 `provider.format` 决定）。
- Anthropic：合并相邻同角色消息，且请求副本末条必须为 user（主动消息会留下 assistant 结尾）；Gemini：`{model}` 占位替换、`systemInstruction`、`x-goog-api-key`。
- `POST /api/ai/chat`：回复结尾 `/continue` 自动续写（默认最多 2 次）；失败回滚用 `splice(userIdx)` 精确移除本轮 user 消息。
- 会话级并发锁：同一 key 同时只能有一个生成任务，第二个返回"正在生成中"。
- `POST /api/ai/proactive`：主动消息（剥离 `/continue`、历史截断 120 条），同时 WS push + Bark + ntfy。
- 定时主动：`resident.json` 里会话 `intervalMin` 为分钟数；扫描间隔默认 60s（`IB_RESIDENT_TICK_MS` 可缩短）。

### 音乐行为

- 点歌按钮走 `GET /api/music/open`：酷狗先隐藏 iframe 触发 `kugou://kugou/play.html?hash=...` 唤起客户端/App，再 `window.open('https://www.kugou.com/song/#hash=...')` 网页兜底；网易云打开 `https://music.163.com/#/song?id=...`。
- `GET /api/music/play` 保留内嵌流式代理；酷狗失败且 `music.fallbackNetease !== false` 时按 `name` 参数自动切网易云外链（实测可放 audio/mpeg）。
- 前端 `ibMusicPlay` 在 Bridge 未启动时也直接尝试打开酷狗网页（fail-open）。
- 背景：酷狗直连播放接口对免费歌/会员 Cookie 一律返回"需要付费"（服务端限制），详见 [DECISIONS.md](DECISIONS.md) D3。

### 推送

Bark（iOS）与 ntfy（Android/OPPO）都支持；`recordPush` 同时记录两者状态到 `push_history.json`，`GET /api/push/history` 供前端"状态"页签展示。

### 配置与数据自愈

- 数据目录（Windows）：`%LOCALAPPDATA%\InternalBeyond\bridge\`，包含 `config.json`、`whispers.json`、`health.json`、`geo.json`、`letters.json`、`sessions.json`、`resident.json`、`context.json`、`push_history.json`、`stickers/`、`tts_*.mp3`。
- 启动时深合并默认配置（缺字段自动补齐并写回）；配置损坏 → 备份 `config.json.broken-*` 并重建；其他数据文件损坏 → 备份 `*.json.broken-*` 并降级为空数据。
- 配置只在启动时读取一次，改配置必须重启服务。

## 5. Active companion 服务（23114）

### 组成

`active-message-service.js`（root，约 268 行）装配五个域工厂 + `active/moments.js`；全部状态读写经 `getState()`（计划域、模型客户端、调度器、HTTP 四层一致），无循环依赖。文件被 require 时不再自启（`require.main` 守卫），`start-active-service.cmd` 直接运行方式不受影响；`module.exports` 供测试直调域函数。

### 状态与持久化

- state 文件版本 3：`plans`、`tasks`、`events`、`armedUsers`（进程本地）、`moments:{}`、`replyChains:{}`；原子写（tmp + fsync + 备份轮换）+ 50ms 合并保存队列；加载时主文件 → .tmp → .bak 依次恢复。
- 吊销/恢复 = armedUsers（重启后需浏览器 reconcile）。

### AI 自主规划主动消息（plans）

**数据流**：`sendChatMessage` 回复保存后 → `_activeMaybePlanNext()`（异步 600ms，fail-open）→ `planNextProactiveMessage()`（`callApiChat` jsonMode + 白名单校验）→ `_activeSaveAiPlan()`（同角色旧 AI 计划替换；绝不替换 `user_reminder`/手动计划）→ IndexedDB `active_message_plans` → 前端 `_activeTick` 30s 调度 + companion 15s 调度（互斥）。

**状态机**：`scheduled → evaluating(原子抢占) → sending → waiting_for_user`（用户回复后取消）/ `cancelled` / `expired`（迟到 >30min 不轰炸）/ `failed`（达 maxAttempts）；`evaluating/sending` 停留 >10min 崩溃回收。

**防重复（四层）**：① IndexedDB 事务原子抢占（`executedLock` 拒绝已执行计划回退，`executedAt` 单调合并）；② 浏览器/companion 互斥（companion 在线且已同步 → 浏览器跳过；浏览器判定离线 → DELETE 副本 + force PUT 抢占，收到 `stalePlan` → 本地标记 waiting 放弃）；③ 生成后复查状态；④ 消息 ID 秒级幂等。

**限制参数**：默认 `MAX_CONSECUTIVE=1`（用户未回复只发一条）；最短间隔 5min 下限/最长 7 天上限（偏好可放宽区间，绝对边界不变）；免打扰 23:00–08:00（可配）；`allowFollowUpPlan` 默认 false（字段已存储供未来扩展）。

**jsonMode 适配**：OpenAI 系 `response_format:{type:'json_object'}`（不支持的中转自动降级重试）、Gemini `responseMimeType`、Anthropic assistant 预填 `{"action":`；所有 provider 均有"严格 JSON 文本 + 容错解析"兜底。普通聊天/流式/DeepSeek think/GLM 隐藏链路零改动。

**companion 新端点**：`GET/PUT/DELETE /plans/:id`（PUT 带 stale/executedLock 服务端权威判定，DELETE 返回 `executed` 标记）；`/reconcile` 只清理调用方声明集合（`task_ids`/`plan_ids`/`moment_ids` 未声明的集合不动，防误删手动任务）。

### Moments 后台调度

- `PUT/GET/DELETE /moments/:characterId`（快照语义：角色偏好 + recent_moments + recent_threads + prefs；PUT 有 user_id 归属 + stale(updatedAt) + executedAt 单调锁）；`/reconcile` 支持 `moment_ids`；`/health` 携带 `moments` 计数（能力探测）与 `reply_chains` 计数。
- 后台只产**纯文字**动态（图片生成依赖浏览器 imageGen 链路）；`schedulerTick` 内可选 `ctx.momentsTick` 钩子（失败被 try 隔离，绝不让 plans/tasks 停止）。
- 浏览器侧互斥：companion 在线且 `/health` 有 moments 能力 → 后台独占（浏览器 tick 不本地生成，仅节流同步快照 ≤60s 一次）；旧版/离线 → 浏览器本地执行（`claimUntil` 3min 认领锁防双标签）。

## 6. AI 社交系统（Moments / Social Net）

### 数据模型（IndexedDB store `moments`，DB_VER 18）

Moment 字段：`id/roleId/authorType('user'|'role')/authorId/content/images[]/visibility(all|user|roles|private)/visibleRoleIds/likes[](string[])/comments[]/source(manual|proactive)/createdAt(ISO)/repostOf/repostText`；Comment：`id/authorType(user|role)/authorId/content/replyTo?/createdAt`。

- **读取侧兼容层**：无 `authorType` 的历史记录按 role 作者解释（`_momentIsUserAuthor` / `_momentsAuthorRoleId`）；`repostOf/repostText/replyTo` 缺省回落渲染。未升 DB_VER，导出/导入结构不变。
- 可见性（作者感知）：`all` 所有可见；`user` 仅用户；`roles` 指定角色；`private` 仅作者自己。用户 private/user 动态对 AI 不可见（除非 roles 列举）；private+role 渲染锁占位卡，private+user 正常卡片。

### 服务层与生成管线

- 服务函数：`createMoment/getMoments/getRoleMoments/getMoment/deleteMoment/likeMoment/addMomentComment/deleteMomentComment`；AI 管线 `generateRoleMoment/generateRoleComment/generateRoleReply`；Prompt Builder `buildMomentPrompt/buildMomentCommentPrompt/buildMomentReplyPrompt`（浏览器与 `active/moments.js` 双端镜像）；聊天注入 `getMomentsContext`（上限 900 字符 = 4 own + 3 others，`_threadMemOk` 门槛）。
- 生成预算：`MOMENT_GEN_MAX_TOKENS=2000`；诊断 stage==='empty-output' 时自适应重试预算加倍（上限 8000）。诊断工具 `_momentsDiagnoseOutput(raw)` 输出 `{outType,len,hasFence,hasBrace,stage,preview}`，stage ∈ empty-output / no-json-object / json-parse-failed / schema-publish-not-boolean / schema-empty-content（解读见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)）。

### 护栏与调度

- 发布频率低/中/高 = 8–16h / 3–6h / 1–2.5h 随机区间；最短发布间隔 45min（`lastPostAt` 会先于去重拦截）；模型返回 `publish:true/false` 不强制发布；失败 console.warn + 60min 退避。
- **动机层（motive，双端镜像）**：JSON 输出增加 `motive ∈ share/daily_life/emotion/reflection/interaction/curiosity/social_response/none`；Prompt 以第一人称【此刻→发圈动机→写作要求】三段要求模型先判断「此刻有没有真实动机」（角色设定/Memory/聊天/主动消息/已发动态/朋友动态/当前时间/距上次发文），无动机即 `publish:false + motive:none`（正常输出，不是失败）；`publish:true` 时 motive 缺失/非法/矛盾归一到 `daily_life`——**motive 不是发布资格门**，发布资格仍由调度+间隔+去重+模型决策共同决定。
- **declineStreak（连续未发计数）**：浏览器 `ib_moments_state_v1[roleId]` 与 companion `schedule.declineStreak`，语义 `publish:true→0 / publish:false→+1`；随 PUT 往返同步（`active/http.js` 按 `lastPostAt` 快慢单调合并），发布事件回传归零。只作为 prompt 上下文（「最近连续 N 次你都没有发」），**无任何 N 次后强制发布的逻辑**。
- 评论：每条动态最多 2 条 AI 评论、每角色评论冷却 45min、同动态同作者去重、评论不再触发评论；触发延迟 20–60s fire-and-forget（localStorage 队列 `ib_moments_commentq_v1` 防双标签，>48h 裁剪）。
- 点赞（AI）：仅 visibility=all、每角色 4 赞/小时、15min 冷却、1h 内与作者互动过则跳过、概率 60% 1 赞/25% 2 赞/15% 0 赞；AI 只加不撤、作者自赞拒绝；零 LLM。
- 亲和度：`_momentsPairAffinity(a,b)` = 40–95 稳定哈希（无存储、无新关系系统）；点赞/评论候选按亲和度过滤与点名，自然出现"常互动/偶尔/潜水"分布。
- 内容质量：发布 Prompt 双端规则 3 拒绝空泛模板（无具体人事物支撑直接 publish:false）；publish:false 是正常输出不是失败；允许短句碎片化。

### AI↔AI 回复链（前台 + 后台）

- 共享核心 `assets/js/reply-chain-core.js`（UMD，浏览器 `<script>` 与 Node require 同一文件）：LIMITS / hashStr / pairAffinity / diceSimilarity / lowInfoMatch / chainRound / canSchedule / replyRoomOk / parseReplyOutput / normalizeReplyTarget / isDuplicateComment / chooseNext / pickNextReplyRole / buildReplyPrompt。
- 常量：`MOMENT_REPLY_MAX_ROUNDS=3`（单线程最多 3 轮回复层，首层评论不计）、`MOMENT_REPLY_COMMENT_MAX=12`、每小时/每日频控 4/12、延迟 30–120s 一步、第三方门槛亲和度 55、链 TTL 7d / 状态上限 200、低信息正则过滤。
- 触发：`addMomentComment` 成功落库 → `_momentsMaybeReplyChain(momentId, commentId)`（幂等：同 comment 只消化一次；旧 comment 拒绝；单线程单 pending；上限预检）→ 延迟 → `_momentsRunReplyStage`（重新校验 → `_momentsPickNextStep` 确定性选角：A 作者回评 / B 已参与者继续 / C 高亲和第三方，一次只选一个）→ 新回复落库后自动安排下一步，直至轮数/评论数/频控/冷却耗尽或模型 decline。
- 幂等三层：① lastConsumedCommentId 拒绝重复消化；② 仅"最新一条评论"可推进；③ pending 拦截并发。刷新后状态在 localStorage（`ib_moments_reply_chain_v1` + 评论时间戳日志 `ib_moments_comment_log_v1` >24h 裁剪）。
- 后台归属互斥：浏览器开着且 companion `/health` 有 `reply_chains` → 链由 companion 独占（浏览器不调度，只节流同步）；否则浏览器本地链照旧。线程合并以「comment id 并集」（后台生成的回复在浏览器 ingest 前不会被快照覆盖）；任务只存指针不复制整帖。taskKey=`momentId:commentId:roleId:round`；running >10min 崩溃回收；到期过 60min 标 expired 不补发；单角色失败重试 15min → failed，不阻塞其它线程。
- 轮数定义：线程中带 replyTo 的角色回复条数（Post→A(首层)→B(→A)→C(→B)=2 轮）。45min 冷却使同一角色在快速链中只发言一次 → "多角色轮流接话"效果。

### Social Net 视图层（social-network.js）

- 页面结构：站点栏 + 页签（默认「社交圈」）、双栏 Feed（头像/昵称/@handle/相对时间/图片网格/点赞/评论/转发/删除/评论预览）、好友栏与好友视图（关注存 localStorage `ib_social_follows_v1`，纯本地标记不进导出）、Profile（Banner/叠压头像/签名/简介/Joined/关注/发布框/动态·回复·媒体三页签）、讨论串弹层（replyTo 树 +「A 回复 B」+ 继续回复）、转发/引用弹层、客户端有界搜索、渲染代际防竞态（`_netPtabSeq/_netFeedSeq`）。
- 包装 `loadMomentsPage` 仅在 page-moments 活动页时接管渲染；直调/后台调用时旧渲染器照常工作（旧契约 id 全部保留：mom-role-filter/mom-feed/mom-compose-* 等）。
- API 编辑器新增「社交身份」区：handle/banner/bio/signature/joinedAt 读写 + @账号规范化查重（大小写不敏感、留空回落）；缺省回落：昵称派生 @slug、渐变 Banner、joinedAt 回落 created。

### 有界读取与存储防护（第三阶段加固）

- `_momentsScanDesc(max)`（byCreated 索引倒序游标 + 4s 兜底 + 索引缺失退化 getAll 截断）与 `_momentsQueryByRole`；热路径扫描上限：聊天注入 150、Feed 360（渲染层仍 30 条/页分页 + 加载更多 `{keepPage}`）、调度上下文 24h 窗口、评论去重 120。
- 存储泄漏治理：commentq 裁剪 >48h 旧键；删除死缓存 `_momentsFeedCache`。
- 图片：1024px JPEG q0.85、单条 ≤9 图、dataUrl≥2.5MB 拒收、AI 发图概率门 45%（能力门 `cfg.imageGen`）+ 最近多条全图防连图、手动上传走 `compressImage`。理论 ~数 MB/月，可接受。

## 7. AI Diary 系统（角色生命日志）

- 存储：IndexedDB `diary_entries`（`id/characterId/date/title/content/mood/diaryType(daily|weekly|event|emotion)/importance(0-10)/relatedMemoryIds/trigger/reason/createdAt`），导出/导入/重置已贯通。
- 调度（仅浏览器前端，companion 未扩展）：`_diaryTick` 挂 30s `_activeTick`——每周周记（默认周日 22:00，周水位线防重复）；每日 AI 规划（每角色每天一次 planner，`shouldWrite` + `importance>=6` 才生成，日水位线占位防重复）；特殊事件（首次聊天、久别重逢间隔 >3 天 → 事件日记，hook 在 `sendChatMessage` 单聊，fire-and-forget）。
- 生成管线 `generateDiaryEntry`：`_diaryContext`（复用主动消息上下文加载）→ `buildDiaryPrompt`（第一人称私人日记，JSON 输出）→ `_diaryParseOutput`（JSON 优先，失败按文本格式「标题：/正文：/心情：」兜底）→ 相似度 ≥0.75 自动重生成一次 → 落库 → `_diaryWriteMemory`（importance≥6 且与现有记忆相似度 <0.8 才写 `memories`，`source:'diary'`）。
- UI：导航「Diary」+ `page-diary`（角色筛选/搜索/统计/「让她写一篇日记」/「今天想写些什么？」/规划设置/时间线/删除）；API 编辑表单头像区「📖 日记」按钮直达。
- 生成预算 maxTokens 2000（与 Moments 同级）。

## 8. 游戏模块（game/ 六文件）

按原语句顺序加载于 `calendar.js` 之后、`room-integration.js` 之前：

| 文件 | 职责 |
|---|---|
| `game_module.js`（约 1614 行） | 房间核心：配置 / CSS 注入 / 状态 G / 视口 / 寻路 / 点击与交互分发 |
| `game_tarot.js` | 塔罗（牌组数据 / 牌面 / 牌阵 / 抽牌与解读 UI） |
| `game_story.js` | Story（AI 分支叙事引擎 + 故事视窗演出） |
| `game_dialogue.js` | 对话（分页 / 打字机 / Sui 问答 / 家园导览，`window.startHomeTour` 在此导出） |
| `game_room.js` | 房间尾段（换装 / 渲染循环 / 精灵 / 存档 / 面板与宠物窗 / bootstrap 与 `window.G` 导出） |
| `game_tea.js` | 茶歇（茶点数据 / 选单 / 精灵动画 / 聊天与存档） |

拆分方式：保持原 IIFE 语句顺序，函数/常量声明按域平移为顶层全局声明（各文件开头 `'use strict'` 保持原严格模式语义）；202 个顶层标识符与 assets/js 全部顶层标识符零冲突；三个 CSS 模板插值无 TDZ 风险。已注册 `IB.game` 合并注册（202 名字）。

行为约定：角色开局处于 sleeping，`onInteract` 会吞掉 sleeping/waking 状态的交互点击；对话打字机打完当前页不会自动翻页，需要点击 next 触发 `advanceDialogue`（第一击收尾打字、第二击翻页、末页触发回调）；Sui 交互需要先走到床边。

## 9. 行为观测层（social-observe）

- `assets/js/social-observe.js`（UMD 双端，与 reply-chain-core 同款模式）：环形事件缓冲 + 按日聚合双轨、方向保留互动矩阵（`actor\u0001target`，用户以哨兵 `user` 入阵）、线程统计纯函数（深度/持续/达限/natural·stale 等）、pairAffinity 快照枚举、小时直方图。LIMITS：TTL 14 天 / 原始事件 ≤3000 / 聚合 ≤30 天 / 归因窗口 5min。
- token 捕获：迟安装包装 `window._tkRecord`（communication.js 三 provider 记账必经点），按 cfg.id+时间窗归因到进行中的社交调用，不改任何请求参数；无 usage 时退化为输入字符计数（`estInputCharsNoUsage`）。
- 接入点全部一行式旁路、失败静默：浏览器 moments.js（发帖/评论/回复/点赞各 blocked 细分与成功路径；companion 事件 ingest 统一入账避免双计）；companion 侧只记后台 llm_call/post_declined/reply_declined/lowinfo/dedupe/block(cooldown_or_rate)（成功结果由浏览器 ingest 记）。
- 持久化：`%LOCALAPPDATA%\InternalBeyond\social-observe.json`（tmp+rename 原子写，30s 节流 + exit flush）。
- 查看/导出：Moments 设置区开关（localStorage `ib_social_obs_v1.enabled`）+ 导出 JSON 按钮；控制台 `await _socialObsPrint(14)` / `await _socialObsStats(30)`。

## 10. 数据存储全景

### IndexedDB（DB_VER 21）

stores 包括：聊天消息（经 dbPut）、`apiConfigs`、`memories`、`blogAnnotations`、`active_message_plans`（v17 起）、`diary_entries`（v17 起）、`moments`（v18，keyPath `id`，索引 `byRole(roleId)`/`byCreated(createdAt)`）、`activities` / `favorites`（v21 起，见 §11.1）。导出/导入：`_ibBuildExportData` 含全部 store（顶层 version 9）、`importAll` 按 keyPath 回灌天然去重。`openDB` 带 `onblocked` 监听（提示关闭旧标签页）。

### localStorage 键（部分）

`ib_chat_sync`（多窗口同步）、`ib_bridge_fab_pos`、`ib_social_follows_v1`（关注）、`ib_moments_reply_chain_v1`、`ib_moments_comment_log_v1`、`ib_moments_commentq_v1`（>48h 裁剪）、`ib_social_obs_v1.enabled`。

### 文件系统

`%LOCALAPPDATA%\InternalBeyond\bridge\*`（§4 清单）、companion state 文件（`IB_ACTIVE_DATA_DIR` 可覆盖）、`%LOCALAPPDATA%\InternalBeyond\social-observe.json`。

## 11. 陪伴活动 / 应用商店 / 收藏夹（Companion World）

> 本组目标是让 InternalBeyond 从「聊天 + 朋友圈 + 通话」进一步变成共享同一套角色/记忆/活动状态/持久化的 **AI Companion World**：Chat / Moments / Call / Coread / Cinema / Favorites / Apps 共用同一套角色、记忆与活动基础设施。全部为 UI 与数据层新增，**不改动** Harness 四文件、ModelPort 等既有边界。

### 11.1 IndexedDB（DB_VER 21）

在既有 28 个 store 之上**增量**新增两个 store（keyPath `id`）：

- `activities` — 陪伴活动会话。字段：`id/type('coread'|'cinema')/roleId/resourceId/resourceKey/title/kind/threadId/progress{page,sec,pct,pageText,recap,subs...}/bookmarks[]/recap/config{}`/status('active'|'paused'|'finished')/createdAt/updatedAt/lastActiveAt`。索引 `byRole`/`byType`。
- `favorites` — 跨模块统一收藏层。字段：`id/type('chat'|'blog'|'letter'|'moment'|'activity'|'cal')/roleId/sourceId/title/body/meta{}/createdAt/updatedAt`。引用式存储：**不复制二进制**（语音/图片在渲染时按 `sourceId` 回读原记录，原记录删除则降级为纯文本）。索引 `byRole`/`byType`。

备份：`_ibBuildExportData` 已含 `activities`/`favorites`，顶层 `version` 升为 **9**；`importAll` 按字段存在性守卫回灌。`site-operations.js` reset 清单与 `local-vault.js` 标签已同步。**保持旧备份（version 8 及更早）可导入**——importAll 为 lenient 逐 store 回灌、按 keyPath id 去重。

### 11.2 统一「Activity / Companion Session Runtime」（`assets/js/activity/activity-runtime.js` → `window.IB.activity`）

Coread 与 Cinema 不各自为政，统一跑在这套运行时上，天然可扩展其它陪伴活动：

- **会话生命周期**：`createActivity`（自动创建/复用一条 `chatThreads` 频道：`kind + resourceKey` 去重，`quiet:true, memory:true`）、`findActivity`、`listActivities`、`saveActivity`、`deleteActivity`、`setProgress`。
- **上下文注入**：`getActivityContext(friendId,{threadId})` 由 `communication.js` 的 `_buildSingleChatContext` 注入（与 `getMomentsContext` 同款钩子）。只透露**到当前页/播放点为止**的内容 + 进度 + 梗概，并附反幻觉边界——即 Mobile 的 `tail()` + `bound()` 语义。`buildActivityContext` 为类型定制（coread=页文本、cinema=最近字幕+进度+帧）。
- **Memory 回写**：`writeMemory` 走 `quickCreateMemory`（`rawSource=coread|cinema`、`domain='陪伴'`、`createdBy=roleId`），写进共享 `memories` 库，能被后续注入。
- **Proactive 联动**：`nudge` 经 `_activeSaveAiPlan` 生成一条**活动感知的主动消息计划** `{source:'ai_planned', intent:'共读/观影…'}`，由既有主动计划机器在设定时刻投递。
- **事件订阅**：`on/off/emit`，供 App 前端订阅 `activity/update`。
- **收藏联动**：`fav` 经 `IB.favorites.add` 把活动收进收藏层。
- 消息页锚：activity 的消息落进频道时带 `threadId`；频道 conversation 即「共读 · 书名」「观影室 · 片名」，与主对话隔离。

### 11.3 Coread（共读间，builtin）

- `assets/js/activity/coread.js` → `window.IB.coread` + `page-coread`。
- 从 Blog（`posts` store）**现读**，不复制书。按段落边界分页（每个读者按 `_charsPerPage`），章节/页码/进度随 `setProgress` 即时写入 `activities.progress`，`getActivityContext` 据此只给 AI 当前页 + 前文梗概。
- 选一位 AI（apiConfigs 非群聊成员），聊天落在 `共读 · 书名` 频道；书签（`bookmarks[]`）、「生成记忆」（writeMemory）、「提醒 TA」（nudge）、「在聊天里打开」（openChat → `page-chat` 选中该频道）。
- 进入：Blog 侧「共读」入口、App Store（builtin）与导航「Apps」→ 打开。

### 11.4 Cinema（观影室，manifest + loader 外部 APP）

- `apps/catalog.json` + `apps/catalog.js`（file:// 退回壳）、`apps/ib-app-cinema.js`（独立 APP）、`assets/js/app-store.js`（loader）。
- APP 经 `IBApps.register({id,version,sdk:2,icon,mount(body,ctx),back,unmount})` 注册，`open(id)` 调 `mount`；APP 只经 `ctx` 与主程序对话（`app/storage/blog/chat/ai/ui/sys/on/off`），**不触碰底层 db/发送函数**——隔离按接口收窄（同 Mobile 约定，非强制 iframe 沙箱）。
- **Media Adapter v1**（`apps/ib-media-adapter.js` → `window.IBMedia`）：统一 `resolveMedia(url|{file}) → {type,provider,id,url,caps{canFrame,canSeek,remote}}` 与 `createAdapter(media,host) → {load,play,pause,seek,getCurrentTime,getDuration,on,destroy}`。支持 `NativeVideoAdapter`（本地/直链 .mp4/.webm/blob:）、`HLSAdapter`（.m3u8，优先浏览器原生 / `window.Hls`，否则 graceful fallback）、`YouTubeAdapter`（官方 iframe API）、`BilibiliAdapter`（官方 embed iframe）、`UnknownAdapter`（未知来源提示，不强行播放）。平台受限（地区/X-Frame-Options/登录/浏览器）只识别并 graceful fallback，**禁止** DRM 绕过 / 防盗链破解 / Cookie·Token 偷取 / 下载受保护视频 / 代理绕过。Cinema Runtime 只依赖统一接口做进度/字幕/弹幕/共看/Memory/Proactive，不复制 Chat/Memory/Activity Runtime。
- 视频/字幕文件**不入库、不随备份**（`ctx.storage` 只存片名/秒数/梗概；播放点不续播）。会话/进度/Memory/Proactive 仍经 `IB.activity` 统一运行时。
- 安装/卸载：enable 集合存 localStorage `ib_apps_on_v1`（app id→1）；builtin 不可卸载、「卸载但保留数据」。

### 11.5 App Store（manifest + loader）

- `assets/js/app-store.js` → `window.IB.apps`：`boot()`（fetch `apps/catalog.json` → script 壳回退）→ `register`/`install`/`uninstall`/`open`/`close`/`isInstalled`/`listEnabled`。
- 外部 APP 按需注入 `<script src="apps/<file>">`（同源 `'self'`，本地离线运行）；`defer` + `data-ibapp`，失败标 `_missing`。
- `page-apps` 渲染 `#appstore-grid`；builtin 项（coread）「打开」即 `navTo('coread')`，外部项（cinema）「打开」走 overlay shell。

### 11.6 收藏夹（Favorites）

- `assets/js/favorites.js` → `window.IB.favorites`：`add/remove/removeBySource/has/list/count`，`type` 为展示语义（text|voice|image|blog|letter|moment|activity|cal）。
- `page-favorites` 收藏墙：按 `type` 分组、引用式解析（语音/图片按 `sourceId` 回读）、长文折叠、语音回放、图片缩略。
- 统一入口 `IB.favorites.add` 供 Chat / Blog / Letters / Moments / 活动共用；`page-favorites` 只读墙，不孤立声明——所有模块经同一层读写。

### 11.7 前端注册与顺序

- 新脚本全部 **UTF-8 BOM**、IIFE `(function(NS){...})(window.IB||(window.IB={}))`、`window` + `IB` 双挂载；加载顺序：`favorites.js → activity/activity-runtime.js → activity/coread.js → app-store.js`（位于 `local-first.js` 之后，全部在 HTML <script> 末端，运行时调用，无加载期依赖）。
- 新增 `assets/css/activity.css`（**外部样式数 19→20**，`test_frontend_structure.js` 已同步）；内联样式预算保持 200/460 不变（全部新样式走 CSS 类）。
- `navTo` 新增 `page-apps`/`page-favorites`/`page-coread` 分派（`typeof xxx==='function'` 守卫）。

## 12. 测试架构

### 统一入口 test-all.js（零依赖，跨平台）

- `node test-all.js --quick`（static + service，约 17s）、`--browser`（Chrome 集成组，串行）、`--all`（默认）。子进程输出透传、任一失败非零退出、分组耗时汇总。服务测试自带随机端口与临时数据目录。
- 截至 2026-08-26：static 2 / service 7 / browser 13 个入口全绿基线（约 150–165s）。（注：原文各节记录的入口/断言计数随轮次增长存在小幅出入，以各日期条目原文为准，见 CHANGELOG。）

### static 组

- `scripts_check_html.js`：提取 HTML 内全部本地 `<script>` 块逐个 `node --check`（39 个脚本）。
- `test_frontend_structure.js`：UTF-8/BOM/乱码检查（递归 assets/css、assets/js、game）、资源路径、拆分约束、设计变量、内联样式预算、入口语义、16+1 张样式表总数与 core 12 段精确加载顺序、子模块 IIFE 首尾断言（com./ws./mem./active.，用 includes 而非正则）。

### service 组

- `test_bridge.js`（82 项断言，零依赖）：健康/CORS/心语 CRUD/上下文/地理/通用会话/AI 常驻(/continue/并发锁/主动消息)/TTS 未配置 503/表情与路径穿越/无效音乐 ID/WS 工具调用/Origin/token/配置自愈/推送历史/Anthropic/Gemini mock 校验/TTS mock 全链路/重启恢复/定时器恢复/数据损坏备份。
- `test_active_http.js`（31 项，真实起服务随机端口）：/plans 端点/stale+executedLock/畸形 URL 不崩/reconcile 互不误删/403/脱敏。
- `test_active_plans.js`（31 项，node --test）：计划校验/状态机/连续限制/崩溃回收/时间戳完整性（注意时钟敏感性，见 TROUBLESHOOTING）。
- `test_moments_companion.js`（16 项）、`test_moments_http.js`（17 项）、`test_socialnet_chain_companion_smoke.js`（17 项，mock 端点）。

### browser 组（CDP，需本机 Chrome/Edge）

`test_dual_window.js`（6 项，动态 `file://` 路径；断言旧 Bridge FAB 为 0、新导航入口为 1；注意：其同步信号用 localStorage 模拟 dbPut 包装器，未走"IndexedDB 写入→包装器→storage 事件"完整浏览器链路）、`test_ui_regression.js`（Desktop/Mobile × Light/Dark 实时切换、Bridge 交互、JS error=0、外部样式数 17）、`test_game_smoke.js`（56 项含命名空间断言）、`test_chat_smoke.js`（31 项，本地 mock OpenAI 端点）、`test_workspace_smoke.js`（28 项）、`test_memory_smoke.js`（23 项）、`test_active_diary_smoke.js`（19 项）、`test_moments_smoke.js`（23 项）、`test_moments_phase2_smoke.js`（28 项）、`test_moments_phase3_smoke.js`（41 项）、`test_moments_user_smoke.js`（24 项）、`test_socialnet_smoke.js`（42 项）、`test_socialnet_chain_smoke.js`（27 项）。

### 测试基础设施约定

- mock 服务器端口 0 自动分配（`listenFree`）；测试端口 `usedPorts` 去重；Bridge 启动 EADDRINUSE 自动换端口重试。
- CDP 测试通用手法与坑（confirm 阻塞、textContent vs innerText、fire-and-forget 审批 Promise 等）见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) §测试。
