# Internal Beyond · 变更历史

> 本文档回答「以前发生过什么」。当前状态与待办见 [HANDOVER.md](HANDOVER.md)；机制如何工作见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 注：原 HANDOVER.md 的章节编号 9.x 沿用为时间线索引；原文即无 9.31，非遗漏。各条目中记录的测试断言/入口计数以当日原文为准（不同轮次间存在小幅出入，未作统一改写）。

## 基线

- 本地 git 基线提交 `e4074cc`（`chore: establish Internal Beyond baseline`）。此后长期有未跟踪文件（`.gitignore`、`active-message-service.js`、`start-active-service.cmd`、`start-vision-service.cmd`、`test_vision.py`、`vision/` 等），直至 2026-08-14 才纳入版本控制。

## 2026-08-04 · Bridge 后端诞生（首个交接对话）

为 [InternalBeyond.html](InternalBeyond.html)（单文件个人 AI 陪伴站）新增并完善**本地一键启动的 Node.js Bridge 后端**，提供表情包、心语墙、健康/定位/天气看板、酷狗点歌、Bark/ntfy 推送、上下文进度条、`/continue` 续写、AI 常驻会话（多模型）、AI 语音气泡（TTS）、多窗口同步等服务端能力，全部通过 WebSocket 工具与 REST 接口接入页面右下角 Bridge 面板。

| 文件 | 说明 |
|---|---|
| `ib-bridge-service.js` | 新增：本地 Bridge 后端（当时约 1700 行，零依赖，Node 18+） |
| `start-bridge-service.cmd` | 新增：Windows 一键启动脚本 |
| `test_bridge.js` | 新增：后端冒烟/功能测试（82 项断言，零依赖） |
| `test_dual_window.js` | 新增：双窗口同步 + 重复初始化测试（CDP） |
| `InternalBeyond.html` | 修改：`</body>` 前新增注入脚本与样式（约 700 行 JS + CSS），标记 `IB Bridge 增强` |
| `README.md` | 修改：新增本地 Bridge 章节、Android/OPPO 用法、酷狗/网易云说明、测试说明 |

## 2026-08-05~06 · AI 自主规划 / 日记系统 / UI 精修 / 修复

三件大事 + 一组修复：

1. **AI 自主规划主动消息**：升级原有主动消息系统——每轮正常聊天后由角色模型自主规划下一次主动联系（时间/意图/取消条件），程序负责调度、频率限制、免打扰、取消、去重与持久化；浏览器与 companion 双执行器防重复。
2. **AI Diary System（角色生命日志）**：混合式生成——每周周记 + 每日 AI 规划 + 特殊事件（首次聊天/久别重逢）+ 手动生成入口；高价值日记自动联动 Memory。
3. **Active 页面 UI 精修**（纯展示零业务改动）：保存按钮防折行、设置三分组（基础/频率与时间/行为与调试）、三级文字对比度变量（浅色/theme-infernal 双主题）、开关三态、最长规划时间"约 N 天"动态辅助（`_activeUpdateMaxHoursHint`）、底部留白、文案去重。
4. **修复**：日记输出"无法解析"（文本格式兜底）、API 编辑页头像空白、IndexedDB 升级阻塞诊断。（细节见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。）

| 文件 | 改动 |
|---|---|
| `InternalBeyond.html` | DB_VER 16→17（`active_message_plans`、`diary_entries` store）；AI 规划主动消息模块约 +1100 行；AI Diary 模块约 +600 行；Active 页 UI CSS/HTML；导航新增「Diary」；API 页头像修复 |
| `active-message-service.js` | companion 支持 AI 计划：plans 状态 JSON v3、GET/PUT/DELETE /plans、reconcile 扩展 plan_ids、schedulerTick 计划扫描与崩溃回收、callCharacterModel 增 jsonMode、require.main 守卫 + module.exports |
| `test_active_plans.js` / `test_active_http.js` | 新增：30 项单元/状态机测试 + 31 项 HTTP 集成测试 |
| `scripts_check_html.js` | 新增：HTML 全部 script 块逐个 node --check |

晚间追加：重写 Edge TTS 真实 bug（帧构造/数据丢弃，从未正常工作过）、修正 `test_active_plans.js` 时钟敏感问题、前端三处修复（`ibTtsFallback` 从未被调用补上调用点、多贴纸回退串名 IIFE 闭包捕获、表情弹窗监听器累积抽 `_ibClosePop` 统一注销）。详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 2026-08-08 · 前端可维护性与回归基线

- `InternalBeyond.html` 从约 2 MB 内联单文件拆为入口 HTML + `assets/css/{core,calendar,bridge}.css` + `assets/js/*.js`（仍按原顺序原生加载，无构建步骤，启动方式不变）。
- 前端拆分文件统一 UTF-8 BOM，新增 `.editorconfig`。
- 全局语义设计变量体系（双主题覆写）；内联 style 从 316 处降到 ≤200 处；导航 a11y、Bridge dialog 语义、Skip Link、reduced-motion；移除重复 Cloudflare beacon；页面后台暂停高频动效/轮询。
- 新增回归入口 `test-ui.cmd`：语法检查、`test_frontend_structure.js`（结构/编码/预算断言）、`test_ui_regression.js`（真实 Chrome Desktop/Mobile 双主题）；`test_dual_window.js` 改动态 file:// 路径并断言旧 FAB 为 0。

## 2026-08-13 · 大拆分日（游戏 / test-all / Bridge / Active / window.IB）

1. **game/ 六文件拆分**：5647 行单文件按域拆为 game_module/game_tarot/game_story/game_dialogue/game_room/game_tea 六个原生脚本（保持 IIFE 语句顺序、顶层声明平移、'use strict' 语义不变）；碰撞审计 202 个顶层标识符零冲突；新增 `test_game_smoke.js`（35 项起步）接入 test-ui.cmd。
2. **统一测试入口 `test-all.js`**：--quick/--browser/--all 三组，子进程输出透传、失败非零退出、耗时汇总。
3. **Bridge 渐进模块化（完成）**：util → config → clients → tts → persistence → ws → routes 七个工厂模块逐步提取，每步 82 项断言全绿；根文件从约 2350 行降至约 998 行纯 composition root。期间踩出 diagnosticsSnapshot 闭包遗漏（见 TROUBLESHOOTING）。
4. **Active 服务拆分（完成）**：persistence → plan-domain → model-client → scheduler → http 五个域模块；`active-message-service.js` 从约 2021 行降至 268 行；期间确立 getter 注入约定（resetStateForTest 重赋值 state 被 `Assignment to constant variable` 当场抓出）。
5. **window.IB 命名空间迁移（完成）**：ib-namespace.js 骨架 + 分批迁移全部 21 个 assets 脚本与 game 六文件（email-links/room-integration/preloader → local-first/local-vault/site-operations → communication/workspace/memory 大文件全量双挂载 → glass/memory-sky/bridge/calendar 等 IIFE 标记迁移 → core/social/integrations/active-diary/game 收官）；`test_game_smoke.js` 最终 56 项含命名空间断言。期间踩坑：calendar.js 误判顶层脚本、'use strict' 序言位置、PowerShell 字符串拼接（均见 TROUBLESHOOTING）。

## 2026-08-13~14 · chat/workspace/memory 冒烟安全网 + 子模块提取

- `test_chat_smoke.js`（19→31 项，mock OpenAI 端点走真实发送链路）落地后，communication.js 依次机械提取四个子模块：`communication/letters.js`（362 行）→ `voice.js`（511 行）→ `annotations.js`（306 行）→ `summary.js`（244 行）；communication.js 从约 4840 行降至约 3600 行。结构测试固化 com.* 断言（IIFE 首尾 + 独立 node --check，includes 而非正则）。
- `test_workspace_smoke.js`（28 项）落地后，workspace.js 提取三子模块：`workspace/files.js`（1366 行）→ `preview.js`（884 行）→ `run.js`（308 行）；workspace.js 从约 3380 行降至 1259 行（协调层）。
- `test_memory_smoke.js`（23 项）落地后提取 `memory/auto-memory.js`（555 行）与 `memory/constellations.js`（104 行）；memory.js 从 2477 行降至 1704 行。**首次提取时发生 ENOENT 数据丢失事故，经 DSH 会话转录 + Cursor 本地 AI 记录完整恢复后重做**（事故与流程教训见 TROUBLESHOOTING T31 / DECISIONS D16）。

## 2026-08-14 · Active/Diary 前端拆分 + Git 检查点 + core.css 拆分

- `test_active_diary_smoke.js`（19 项）安全网落地后：提取 `assets/js/active-diary/active-plans.js`（949 行）与 `diary.js`（457 行）；父文件 active-diary.js 从约 2235 行降至 843 行；改写前存 Git blob `e0f151bb…` 备份，顶层声明集合核对 143 → 143 零缺失。
- **Git 安全基线**：全量测试绿后提交 **`800411d`**（`refactor: modularize local services and frontend domains`），assets/、active/、bridge/、游戏子模块和测试入口纳入版本控制；`.dsh-recovery/` 加入 .gitignore。
- **core.css 严格连续拆分**：3643 行切成 12 个连续文件（core.css 保留前 383 行基础主题）；层叠完整性验证——去 BOM 后依次拼接与提交中原文件精确相等（359440 UTF-8 字节）；结构测试递归检查新目录 + 16 张样式表总数与 core 12 段精确加载顺序断言；`test_ui_regression.js` 焦点检查改为最多 1.5s 等待实际聚焦（修时序 flake）。

## 2026-08-24 · AI 朋友圈 Moments 第一阶段

每个 AI Role 拥有持续存在的朋友圈：用户可浏览/点赞/评论/删除，AI 按频率自主发布（可选择不发布）、互相评论（有限/冷却/去重），动态轻量注入聊天上下文；全部复用 IndexedDB、callApiChat、Memory 检索、主动消息相似度与 `_activeTick` 调度，零新增基础设施。

- DB_VER 17→18（store `moments`，索引 byRole/byCreated）；导出 version:8 增加 moments 键。
- 新文件：`assets/js/moments.js`（约 780 行，createElement 防注入）、`assets/css/moments.css`、`test_moments_smoke.js`（23 项 CDP 冒烟）。
- 服务层 + AI 管线 + Prompt Builder + 聊天注入 `getMomentsContext` + 调度 `_momentsTick`（挂在 active-diary.js 的 `_activeTick`，与 `_diaryTick` 同挂点）。
- 护栏：频率低/中/高 = 8–16h/3–6h/1–2.5h；最短间隔 45min；publish:false 不强制；每动态 ≤2 条 AI 评论、45min 冷却、同作者去重、评论不触发评论；可见性 all/user/roles/private。
- UI：导航 Moments + page-moments 微信式卡片、角色筛选、手动发布卡、设置卡、移动端适配。
- 注意事项沉淀：edit 工具剥 BOM 必须补回；新文件必须 BOM + UTF-8；聊天注入块放记忆注入之后且 try/catch fail-open。
- 第二阶段候选（当时列出）：AI 生图发朋友圈、AI 点赞、关注/转发/通知、companion 后台调度、内容语义索引。

## 2026-08-26 · Moments 第二阶段（图文/点赞/Private/后台调度）

四项增量：AI 图文朋友圈（复用 imageGen 生图链路，能力门 + 45% 概率门 + 连图抑制）、AI 点赞（轻量规则零模型调用）、Private 私人日志 UI（锁占位卡）、companion 后台朋友圈调度（复用统一 tick/events/reconcile/executedAt 体系）。

- Companion 侧新增 `active/moments.js` 域模块；persistence 状态加 moments（additive v3）；schedulerTick 可选 momentsTick 钩子；HTTP 新增 GET/PUT/DELETE /moments/:characterId、reconcile 支持 moment_ids、/health 带 moments 计数。
- 浏览器侧：includeImage/imagePrompt 解析、`_momentsMakeImage`、likeMoment、Private 切换 UI、Feed 分页 30 条/页 + 加载更多、大图查看、「允许 AI 点赞」开关。
- 后台互斥：companion 在线 → 后台独占（浏览器只节流同步快照 ≤60s）；旧版/离线回退本地（claimUntil 认领锁）；事件落库按 moment.id 幂等。
- 测试：`test_moments_companion.js`（12 项起步）、`test_moments_http.js`（17 项）、`test_moments_phase2_smoke.js`（28 项）。
- 已知限制（诚实清单）：后台只产纯文字（图片依赖浏览器 imageGen）；调度需页面至少打开一次同步 nextAt；旧版 companion 自动回退不双发；渲染层分页；PUT 全量快照 60s 节流。

## 2026-08-26 · Moments 第三阶段（长期运行审计与稳定性加固）

从"功能完成"到"可长期运行"：有界读取（byCreated/byRole 游标扫描上限：聊天注入 150/Feed 360/调度 24h/去重 120）、localStorage 泄漏裁剪（commentq >48h、删 _momentsFeedCache 死缓存）、AI 社交差异化（_momentsPairAffinity 40–95 稳定哈希亲和度，点赞/评论候选过滤点名）、反空泛模板 Prompt（双端镜像规则 3 + publish:false 正常化）、nextAt 脏数据自愈。Scheduler/Companion/Privacy/Export 审计确认达标未做无意义重构；图片存储与 Context/Token 复审确认足够。

- 测试：test_moments_companion 12→16、新增 `test_moments_phase3_smoke.js`（28 项起步）。
- 有意保留的技术债清单见 [DECISIONS.md](DECISIONS.md) D14。

## 2026-08-26 · Moments User 作者身份

朋友圈作者扩展为 user | role 双作者（authorType/authorId 新字段 + 读取侧兼容层，不迁移不升版本）；Compose UI 改为用户本人发布（复用 Profile 昵称/头像，移除角色选择，"让 TA 发一条"保留为 AI 代发入口）；可见性语义作者感知（用户 private/user 动态对 AI 不可见）；likes 天然区分未引前缀；AI 互动走既有管线（调度器只遍历 apiConfigs，用户动态绝不触发自主发帖）；Prompt 中用户动态以 Profile 昵称标注。新增 `test_moments_user_smoke.js`（24 项）。

## 2026-08-26 · 修复 Moments Companion 同步 404（能力预检契约）

23114 上 PUT /moments 持续 404 的真因 = 运行中的是第二阶段之前启动的**旧版 companion 进程**（代码树路由正确，test_moments_http 17 项对真实服务全过）。修复前端 `_momentsSyncCompanion`：同步前 GET /health 能力预检（无 moments 字段 → 零 PUT 直接回退本地调度）、循环内单角色 404/400 立即 break、5 分钟窗口自动重探恢复。运维提示：重启一次 companion 即恢复后台调度。契约设计见 DECISIONS D9。

## 2026-08-26 · 定位 Moments 输出解析失败 + 修复 reasoning 吃满预算

先诊断后修复两步：

1. 代码审计排除 wrapper 格式/markdown 围栏/publish:false/jsonMode 映射等问题；新增结构化诊断 `_momentsDiagnoseOutput(raw)`（stage 分类：empty-output/no-json-object/json-parse-failed/schema-publish-not-boolean/schema-empty-content）+ 解析矩阵测试。
2. mock 推理型端点复现确认：reasoning 吃满 maxTokens=900 导致 content 空。最小修复：MOMENT_GEN_MAX_TOKENS=2000 + 自适应重试提额（上限 8000）；不动 jsonMode/schema/其他链路。决策记录见 DECISIONS D12。

## 2026-08-26 · AI 社交网络 Social Net 第一阶段（数据层 A + UI 闭环 B）

产品方向调整：Moments 改造为「AI 社交网络」（Banner + Avatar 主页、双栏 Feed、好友、讨论串、转发引用），默认进入「社交圈」。

- 新增 `assets/js/social-network.js`（约 770 行视图层，IB.socialnet）与 `assets/css/social.css`（约 420 行）；page-moments 重写为社交站结构，**全部旧契约 id 保留**；导航改名「社交圈」。
- API 编辑器新增「社交身份」区（handle/banner/bio/signature/joinedAt + @ 查重）；moments.js 仅三处薄增（repostOf/repostText/replyTo 兼容字段），其余 1200+ 行零改动。
- 关键设计（不重写 moments.js / 向后兼容 / 旧 DOM 契约 / 关注纯本地标记 / AI↔AI 续链留待下阶段）见 DECISIONS D8/D9。
- 新增 `test_socialnet_smoke.js`（42 项）。

## 2026-08-26 · AI↔AI 连续社交链（前台回复线程化）

实现「发帖 → 首层评论 → 作者回评 → 第三方加入 → 再回复」连续线程：只薄增 moments.js + 新测试；UI/数据结构/companion/DB_VER 不动。常量、状态（ib_moments_reply_chain_v1 / comment_log_v1）、Prompt、生成、触发器、幂等三层、轮数定义等机制见 ARCHITECTURE §6；关键设计（一次一步/释放槽位/45min 冷却塑造轮流接话）见 DECISIONS D11。新增 `test_socialnet_chain_smoke.js`（27 项）。

## 2026-08-26 · Companion 后台 AI↔AI 连续社交链

让 companion 在浏览器关闭后继续推进已有线程。**未修改通信协议**：沿用 PUT /moments 快照（附加 recent_threads/prefs）+ events 回传 + reconcile；/health 加 reply_chains 计数（能力探测）。新增唯一共享实现 `assets/js/reply-chain-core.js`（UMD，前后台同一文件，规则/Prompt/常量零分叉）；companion 侧 reply-chain 域（syncReplyChainThreads / maybeCreateReplyTask / executeReplyChainTask / crashRecover / prune，全局 32 + 每角色 4 上限，taskKey 确定性）；归属互斥（companion 在线且支持 → 独占）。审计结论、改动文件表、关键设计见 ARCHITECTURE §5–6 与 DECISIONS D10。新增 `test_socialnet_chain_companion_smoke.js`（17 项）。

## 2026-08-26 · 行为观测层（观察期准备；纯旁路零行为变更）

为关系系统参数校准建立本地观测：`assets/js/social-observe.js`（UMD 双端环形缓冲 + 按日聚合 + 方向保留互动矩阵 + 线程统计 + 亲和度枚举 + 小时直方图）；token 捕获（迟安装包装 window._tkRecord，不改请求参数）；接入点全部一行式旁路失败静默；持久化 social-observe.json（30s 节流原子写）；Moments 设置区开关 + 导出按钮 + 控制台查询函数。现有测试断言零修改，全量绿。

**当前状态：校准等待中——关系状态层的实现被明确禁止，直到 1–2 周真实分布数据回填（见 [HANDOVER.md](HANDOVER.md) 当前工作）。**

## 2026-08-27 · TTS 第三阶段 A（MiMo 普通 TTS）与 B1（VoiceClone Reference Audio 基础设施）

**第三阶段 A**（已在工作树基线）：`bridge/tts.js` Provider Registry 扩为 Edge / OpenAI / MiMo 三 provider（`mimo-v2.5-tts`，chat-completions 兼容：文本在 assistant 消息、风格指令在可选 user 消息、`audio.{format,voice}`）；`normalizeVoiceProfile` 按 capabilities 过滤（MiMo 无 prosody/language → rate/pitch/language 置空）；前端 `IB_TTS_CATALOG` 镜像目录驱动 Provider/Model/Voice 下拉，`_ibTtsPayload` 统一 wire payload；新增 `test_mimo_tts.js`（31 项，registry 形态 + 请求 shape + 错误分类 + Edge/OpenAI 回归）。**`mimo.clone = false` 保持不动。**

**B1 · VoiceClone Reference Audio 基础设施**（本条目）：独立资产层，只做「上传 → 校验 → 落盘 → 引用」，**不实现 MiMo VoiceClone API、不上行任何克隆请求**。

- 新文件 `bridge/tts-voices.js`（工厂）：文件在 `DATA_DIR/tts-voices/<refAudioId>.<ext>`，服务端 metadata 注册表 `DATA_DIR/tts-voices.json`（refAudioId → {mime,ext,size,originalName,created}）；refAudioId = crypto.randomBytes(9) base64url（12 字符，白名单 `[A-Za-z0-9_-]{8,64}`）；**三方校验**：Content-Type（audio/mpeg|wav 族）+ 扩展名 + magic bytes（MP3: ID3 标签或 MPEG 帧同步；WAV: RIFF....WAVE），全一致才接受；10 MB 上限在 Content-Length 入口预检、流式读取、写盘前三层硬核；原始文件名剥离路径成分只作 metadata；`resolveRefAudio` 只由「id + 注册表 ext」拼路径，杜绝任意文件读取。
- `bridge/routes.js`：`POST /api/tts/voices`（原始二进制 body，`?name=` 仅元数据）、`GET /api/tts/voices`（列表 + 磁盘↔注册表对账诊断）、`GET/HEAD /api/tts/voices/:id`（只认注册表）、`DELETE /api/tts/voices/:id`（body `{referencedIds:[...]}` 声明当前仍被角色引用的 id，命中 409 拒删，防止「删掉后角色 VoiceClone 静默失效」）；`/api/diagnostics` 增 `voiceAssets` 对账块；新增流式 `readRawBody`（边读边超限拒绝，不整包读入）。
- 前端：Voice 编辑器增加 **Voice Type（○ Built-in ○ Voice Clone）**，选 Clone 只显示 Reference Audio（上传/当前:名称+大小/删除 + 存在性检查状态），不显示 Clone API 参数/MiMo VoiceClone Model/Style 克隆逻辑，Test Voice 在 Clone 下禁用；voiceData 合并式写入（`Object.assign(既有 voiceData, {refAudioId,mime,name,size})`，**futureField 等字段永不被抹除**）；导出保持只含 metadata（apiConfigs 直出 JSON，无 base64/二进制）；导入后 `ibTtsVoiceCheckImport` 检测 dangling reference 并 alert 明确状态。
- 测试：`test_tts_voices.js`（53 项：模块层 + 真实 Bridge HTTP，含 10MB/空文件/伪造 MIME/扩展名不一致/路径穿越全部 4xx/引用拒删/重启持久化/对账诊断）；`test_ui_regression.js` 新增 13 项真实 Chrome headless（真 Bridge 上传 + 编辑器保存/重开/解绑删除/futureField 保留）。注意：`assets/js/social.js` 内嵌 HTML 转义用全局 `esc`（bridge.js 的 `ibEsc` 是 IIFE 私有，非 window 全局）。

**B1 边界（预期行为）**：`voiceType='clone'` 可保存、可持久化、可引用 Reference Audio，但 TTS normalize 仍按 capabilities 回落 builtin——克隆合成留待 B2（`mimo-v2.5-tts-voiceclone` 未实现，未调用任何 VoiceClone API）。

## 2026-08-27 · TTS 第三阶段 B2：MiMo VoiceClone 合成链路

先重新检索官方文档（mimo.mi.com 官方 API + quick-start「使用音色复刻进行语音合成」章节），按**最新官方实据**实现，未凭记忆猜参数：

**官方实据**：`POST https://api.xiaomimimo.com/v1/chat/completions`；model=`mimo-v2.5-tts-voiceclone`；鉴权 `api-key`（与普通 TTS 一致）；`audio.voice` **必填且为** `data:{MIME};base64,<b64>`（仅 mp3/wav 样本，MIME 与样本一致；Base64 编码后 ≤10 MB）；目标文本在 `assistant` 消息；`user` 消息可选、非空即自然语言风格指令；**不用**普通内置 voiceId（音色由参考音频决定）；无独立 `language` 参数、无 `rate/pitch`；非流式响应 `choices[0].message.audio.data` 为 base64（格式=请求 `audio.format`），另有 `audio.id/expires_at(null)/transcript(null)`。

实现要点：
- `bridge/tts.js`：`mimo.capabilities.clone=false→true`（仅 mimo；edge/openai 仍 clone:false + 无 cloneSynthesize）；新增 `cloneModels:['mimo-v2.5-tts-voiceclone']`（常量 `MIMO_CLONE_MODEL`）与 `mimoCloneSynthesize`；`normalizeVoiceProfile` 在 clone 且 provider 有 cloneModels 时**强制落到官方克隆模型**（显式指定过 clone model 才保留，误填 builtin model/空值均兜底），非 clone 走既有 models 规则（旧行为不变）；`ttsSynthesize` 按 `voice.type==='clone' && def.cloneSynthesize` 分派（当前仅 mimo）；`mimoCloneSynthesize` 经 `ttsVoices.resolveRefAudio` 读取 B1 文件（不直接拼 DATA_DIR 路径、不破坏 B1 安全边界），空引用/不存在/注册表有记录但文件缺失/读取失败/Base64 超官方 10 MB 一律本地 `ok:false` 失败、绝不发上游。
- `ib-bridge-service.js`：`ttsVoices` 提前到 `createTts` 之前创建并注入。
- 前端（`assets/js/social.js`、`InternalBeyond.html`、`assets/css/core/api-components.css`）：目录 `mimo` 增 `clone:true + cloneModels`；`_voiceSyncCapabilityFields`/`_voiceSyncModelOptions` 按类型显隐：Clone 时隐藏 Provider 行/预置音色/lang/prosody、显示克隆模型下拉（默认 `mimo-v2.5-tts-voiceclone`）+Style + Test Voice（**不再禁用**）；`_voiceTypeChange` 选 Clone 时把 Provider 固定为 MiMo（避免 edge/openai+clone 被 normalize 回落 builtin 造成“选了克隆却是内置音色”的困惑）；`testCharacterVoice` 按当前类型构造 `voiceType/voiceData`，Clone 模式走真实 `/api/tts`；Built-in 行为、挂载顺序、旧数据兼容（`voiceType` 缺失仍=builtin）全部不变。
- 测试：`test_mimo_voiceclone.js`（新，35 项：Registry/edge+openai clone:false/Normalize→clone model/Reference Audio 解析/Base64 逐字节一致（data URI 前缀解码）/request shape/model/无 language/无 rate/pitch/style 空与非空/空引用不发请求/注册表-文件缺失/超 10MB Base64 本地拒绝/builtin 回归仍 `mimo-v2.5-tts` 且 no data URI/未配置错误分类）；`test_mimo_tts.js` 的 `A.capabilities.cloneFalse` 更新为 `cloneTrue + cloneModels`（B2 有意翻转，其余断言不动）；`test_ui_regression.js` B1 块改断言（Test 不再禁用、provider 行隐藏、clone model 默认），并新增 B2 块（真实 Chrome headless：mock VoiceClone 端点 + Provider=MiMo + Clone + 上传 → Test Voice 成功 + 捕获请求 shape：`mimo-v2.5-tts-voiceclone`/`format:'mp3'`/`data:audio/mpeg;base64,`/assistant 文本/api-key 头，runtime 无 JS 异常）。
- 取舍与边界（报告已注明）：输出 `audio.format='mp3'` 沿用 B1 `.mp3`+`audio/mpeg` 播放链（官方默认 `wav`）；仅 tokenplan/第三方代理上才见 `mimo-v2.5-tts-voiceclone` 需要，此处为官方直连。**未实现 Voice Design**；`mimo-v2.5-tts-voicedesign` 未建假条目。真实上游 API **未调用**（无 MiMo API Key；全部为本地 mock 断言，mock 已明确标记）。

**B2 最终状态**：VoiceClone 合成已完整可用（上传→引用→`/api/tts`→`normalize`→`mimo` clone adapter→`resolveRefAudio` 读文件→`data:...;base64`→`mimo-v2.5-tts-voiceclone`→现有播放链）。已知限制：① 无真实上游调用实测（未持有 MiMo Key）；② 输出格式 mp3 为兼容既有播放链的取舍（官方默认 wav）；③ 10 MB 官方 Base64 上限意味着参考音频原文件需 ≤ 约 7.5 MB（超出本地拒绝，B1 上传上限 10 MB 仍放行但 adapter 会拦截）。

## 2026-08-28 · AI 朋友圈「自主发文动机层」（motive + declineStreak，轻量增强非重构）

在既有「心跳 → 到期认领 → LLM 决策 → 去重/频控 → 落库」调度之上，增加一层语义决策：**「此刻为什么想发」**，目标是增强角色自主性而非提高发帖频率。**调度、Claim、Companion 互斥、频控、去重、图片链路全部未改动。**

- **motive 枚举**（浏览器 `assets/js/moments.js` 与 companion `active/moments.js` 双端镜像）：`share / daily_life / emotion / reflection / interaction / curiosity / social_response / none`。输出 JSON 增加 `"motive"` 字段（schema 行、重试提示串、`_momentsParseOutput`/`parseMomentOutput` 共 4 处同步）。
- **归一规则**：`publish:false` → 强制 `motive:'none'`；`publish:true` 且缺失/非法/矛盾（`none`）→ `daily_life`；**motive 不是发布资格门**，不因它拒绝/放行任何发布。落库 moment 记录新增 `motive` 字段（`_momentsDefaults` 白名单，手动/用户动态为 `''`），companion 事件回传携带 `moment.motive`，浏览器 ingest 幂等落库。
- **declineStreak（连续未发计数）**：浏览器 `ib_moments_state_v1[roleId].declineStreak` + companion `schedule.declineStreak`（`sanitizeMomentSchedule` 白名单 + `publicMomentSchedule` 暴露 `decline_streak`）。语义 `publish:true → 0`、`publish:false → +1`（发布事件与 PUT 往返双端同步、`active/http.js` 按 lastPostAt 快慢做单调合并）。**只作为 prompt 上下文**（「最近连续 N 次你都没有发」），**无任何强制发帖逻辑**——连续 declined 不发是正常结果。
- **Prompt 决策流程**（双端镜像改写）：第一人称「【此刻】→【发圈动机】→【写作要求】」三段；Step1 有没有真实动机（结合角色设定/Memory/最近聊天/主动消息/最近朋友圈/朋友动态/当前时间/距离上次发文），Step2 选 motive（含每项一句释义），Step3 正文由动机自然产生；「今天没想发」是正常输出不是失败。按需求移除 prompt 中的任务/定时/调度/内部机制等词（防泄漏句保留并改写），现有反空泛模板、publish:false 正常化、碎片化等规则原文保留（既有断言零修改）。
- **观测**：`post`/`post_declined` 事件增加 `motive`（`post_declined` 恒为 `'none'`），`social-observe.js` record() 原样透传无需改动。
- **测试**：`test_moments_companion.js`（+3 项：motive 归一 / declineStreak 累加与发布归零 / sanitize 透传）、`test_moments_http.js`（+3 项：declineStreak 初写/单调取大/发布后归零）、`test_moments_phase3_smoke.js`（+7 项：Case A–E,G——发布携带 motive 落库/无动机正常 decline+streak/连续 declined 不强制/发布归零/去重不被绕过/prompt 动机段与无内部机制词/发布正文干净）；`test_moments_smoke.js`、`test_moments_phase2_smoke.js`、`test_socialnet_chain_companion_smoke.js`、`scripts_check_html.js` 全绿（零回归）。

## 2026-08-27 · TTS 第三阶段 C：MiMo Voice Design（mimo-v2.5-tts-voicedesign）

按同日官方文档（API 参考 + quick-start「使用文本设计音色」）核实后实现，仍为 B2 的镜像增量，**未重构 TTS、未新增第二套播放链/资产系统/DB**。

**官方实据**：同一 endpoint/`api-key`；model=`mimo-v2.5-tts-voicedesign`；`role:"user"` 的 content = **音色设计描述（必填）**，`role:"assistant"` 的 content = 目标合成文本（必填）；**无 `audio.voice`**（音色由描述生成）；**无独立 `language`、无 `rate/pitch`**；`audio.format` 默认 `wav`（通用文档允许 `mp3`）；`optimize_text_preview` 可选（仅 design，默认 false，我们总有目标文本故不设）；非流式响应 `choices[0].message.audio.data` 同构。**官方不产生可复用 Voice ID / 资产**（`audio.id` 为响应级标识、`expires_at=null`）——无需持久化额外资产，输出可直接播放。

实现要点：
- `bridge/tts.js`：`mimo.capabilities.design=false→true`；新增 `MIMO_DESIGN_MODEL`、`designModels:['mimo-v2.5-tts-voicedesign']`、`designSynthesize:mimoDesignSynthesize`；normalize 的 model 块在 `vtype==='design'` 时强制落到官方专用 model（误填 builtin/空值兜底）；`ttsSynthesize` 加 `isDesign && def.designSynthesize` 分派；`mimoDesignSynthesize` 复用 `saveTtsAudio`/播放链/`/api/tts`/WS `tts_speak`；空设计描述本地拒绝（官方 user 必填），错误分类/未配置同 clone。**`mimoSynthesize`/`mimoCloneSynthesize` 零改动**；edge/openai 保持 design:false（normalize 回落 builtin）。
- 前端（`assets/js/social.js`、`InternalBeyond.html`）：目录 `mimo` 增 `design:true + designModels + designModelLabel`；Voice Type 单选增 `Voice Design`（`#api-voice-type-design`）；`_voiceCurrentType`/`_voiceSetType` 支持 `design`；`_voiceSyncCapabilityFields` 在 design 下隐藏 Provider 行/预置音色/lang/prosody、把 **Style 标签切为「Voice Design 描述（音色设计）」**（复用 `voice.style` 承载音色描述，不造重复字段）、显示 design Model 下拉（默认 `mimo-v2.5-tts-voicedesign`）+ Test Voice；`_voiceTypeChange` 对 clone/design 都强制 provider=mimo；`_voiceCloneRender` 在 design 下隐藏 Reference Audio（clone）面板；`testCharacterVoice` 的 design 分支要求非空描述、走真实 `/api/tts`；`editApi` 恢复 design 类型；保存块复读 `_voiceCurrentType`，design 走 voiceData 透传（futureField 兼容），无 design 专属字段。目录驱动逻辑与 B1/B2 一致，未写死大量 provider 分支。
- 测试：`test_mimo_voicedesign.js`（新，39 项：Registry(design)/edge+openai design:false×无 designSynthesize/normalize design/非 mimo+design 回落 builtin/design model 默认值/request shape+method+api-key/design 描述→user 消息/目标文本→assistant/无 audio.voice/无 language·rate·pitch·无未确认字段/response 解析/空描述本地拒绝/未配置/401·403·400·500·no audio 分类/VoiceClone 回归 data URI/Built-in 回归 `mimo-v2.5-tts`+预置音色/OpenAI 回归 Bearer+四字段）；`test_mimo_tts.js` 的 `A.capabilities.designFalse` 更新为 `designTrue + designModels`（C 有意翻转，其余断言不动）；`test_ui_regression.js` 新增 C 块（真实 Chrome headless：Provider=MiMo + Design + 「Voice Design 描述」→ 保存 → IndexedDB 回读 → 重开恢复 → Test Voice，mock 捕获 `mimo-v2.5-tts-voicedesign`/`format:'mp3'`/无 `audio.voice`/user 描述=音色描述/api-key 头，runtime 无 JS 异常）。

**C 边界与限制**：仅 `provider=mimo`+`voiceType=design` 进设计适配器；`voiceType` 缺失仍 builtin（旧角色不变）；Edge/OpenAI/MiMo Built-in/MiMo VoiceClone/Reference Audio/fallback/播放队列/export·import/futureField 全部不受影响。真实上游 API **未调用**（无 MiMo Key；全部为本地 mock，mock 已明确标记）。**未实现**：其他 Provider Voice Design、云端 Voice Library/Marketplace、自动同步、伪 2 播放链、企业级安全。官方 `optimize_text_preview`（LLM 润色/自动生成播报文本）未接入——本阶段总提供目标文本，不设该参数；留待后续按需单独加。

## 2026-08-27 · 朋友圈讨论串：回复嵌套缩进扁平化

用户反馈「讨论串里 AI 回复的位置奇怪/没对齐」——逐像素与真实 Chrome DOM 复核后确认：弹窗定位、头像、时间/回复脚注、行序均正确，异常点是**回复的越级嵌套缩进**（`.net-cmt.depth-1/2/3` 的 `margin-left:34/52/70px`，与首页卡片上的评论预览"全平"不一致，且深层级把文本列挤窄）。修复：`assets/css/social.css` 将 depth-1/2/3 统一 `margin-left:0`（桌面与移动端媒体查询同步）——所有评论含多级回复统一左对齐，回复关系由行内「回复 XX：」前缀表达，与卡片预览/微信动量式讨论串惯例一致；DOM 层级与排序逻辑（父行后接其子回复的树序）保持不变。`test_socialnet_smoke.js`、`test-all.js --quick` 全绿（结构测试首跑因编辑工具剥除 BOM 失败 1 项，已恢复）。

## 2026-08-27 · TTS 第三阶段最终验收审计（A/B1/B2/C 封板检查）

审计结论：A/B1/B2/C 已贯通，可封板；确认 3 个 UI 状态机脏字段缺陷（真实 Chrome headless 复现）并最小修复：

1. **Clone/Design → Built-in 残留专用 model**：`_voiceSyncModelOptions` Built-in 分支把切换前的 `mimo-v2.5-tts-voiceclone`/`mimo-v2.5-tts-voicedesign` 当「(当前配置)」保留，保存后角色的 `voiceType='builtin'` 却带上专用 model，播放时上游收到错配请求。修复：目录级检查，专用 model 一律丢弃回落「跟随全局配置/官方默认」（`assets/js/social.js`）；服务端 `normalizeVoiceProfileCore` Built-in 分支同规则兜底（误填专用 model 按未指定处理，`bridge/tts.js`）——双保险，旧数据/手改 JSON 也安全。
2. **Built-in → Clone → Built-in 不回退 Provider**：`_voiceTypeChange` 强制 provider=mimo 后无记忆，旧 Edge 角色看一眼 Clone 再切回来，保存即被静默改成 mimo（且 voiceId 错配）。修复：`_voiceProvBeforeSpecial` 记忆强制前 provider，回 Built-in 恢复；编辑器打开（addNewApi/editApi）时重置（仅当次会话内生效）。
3. **Voice 下拉跨角色残留**：无官方预置目录的 provider（edge/openai）同步下拉时把上一个角色/上一次会话残留的 id 以「(当前配置)」形式保留，切回有目录 provider 时选中错误音色。修复：`_voiceSyncVoiceOptions` 无目录时清空下拉；`_voiceToggleDetail` 无条件调用同步。

测试：`test_ui_regression.js` B1 块增 `unbindNoDirtyModel` / `unbindProviderConsistent` 两项回归；`node --check`、`test-all.js --quick`、`test_ui_regression.js`、`test-all.js --all` 全部通过。真实 MiMo 上游 API **未调用**（本机无 Key；request shape 均为本地 mock 验证）。
