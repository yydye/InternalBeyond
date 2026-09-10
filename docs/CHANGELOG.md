# Internal Beyond · 变更历史

> 本文档回答「以前发生过什么」。当前状态与待办见 [HANDOVER.md](HANDOVER.md)；机制如何工作见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 注：原 HANDOVER.md 的章节编号 9.x 沿用为时间线索引；原文即无 9.31，非遗漏。各条目中记录的测试断言/入口计数以当日原文为准（不同轮次间存在小幅出入，未作统一改写）。

## ✦ 作者彩蛋（关系是怎么"演"出来的）

`［叙事］` 有一件被作者本人证实、却从未写进任何"机制"文档的事：**想要两个角色在社交圈里聊得很嗨，最有效的办法不是等关系状态层（D13），而是直接把关系写进她们各自的系统提示词。** 一句「A 和小 B 是多年挚友 / 恋人」，加上已有的 `pairAffinity` 哈希（决定谁会被点名互动）+ 回复链（45min 冷却、一次一步、多角色轮流接话），角色便会顺着这份声明在朋友圈里你来我往——**结果意外地跟真人差不多**。

> 这其实是这个项目一条隐藏真相的注脚：**它最像真的地方，不在算法多聪明，而在作者肯把感情直接写进人格，再让机制和模型替他把那份感情演出来。** 写死进系统提示词的关系是**静态、恒温**的（不会生分、不会争吵），对个人陪伴站来说，这恰恰是状态层给不了的"稳定的人情味"——而且完全在 D13 边界内（那是**叙事选择**，不是**状态机制**，不存储、不演化、不评分）。
>
> 关联：[DECISIONS.md](DECISIONS.md) D13（关系状态层提前实现禁令）；[SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md)（pairAffinity / 回复链）；[WHY_IB.md](WHY_IB.md)（"边界靠 prompt + 调度，而非单独引擎"）。

## 基线

- 本地 git 基线提交 `e4074cc`（`chore: establish Internal Beyond baseline`）。此后长期有未跟踪文件（`.gitignore`、`active-message-service.js`、`start-active-service.cmd`、`start-vision-service.cmd`、`test_vision.py`、`vision/` 等），直至 2026-08-14 才纳入版本控制。

## 2026-08-04 · Bridge 后端诞生（首个交接对话）

为 [InternalBeyond.html](../InternalBeyond.html)（单文件个人 AI 陪伴站）新增并完善**本地一键启动的 Node.js Bridge 后端**，提供表情包、心语墙、健康/定位/天气看板、酷狗点歌、Bark/ntfy 推送、上下文进度条、`/continue` 续写、AI 常驻会话（多模型）、AI 语音气泡（TTS）、多窗口同步等服务端能力，全部通过 WebSocket 工具与 REST 接口接入页面右下角 Bridge 面板。

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

## 2026-09-02 · Proactive Interaction v1（AI 主动发起联系 + 全屏语音通话 UI + 全局短回合策略）

在既有主动消息规划（`active-plans.js` AI 计划域）与 Voice Runtime（`bridge/voice-runtime.js` + `assets/js/communication/call.js`）之上做**增量扩展**，不新建第二套 Chat/Memory/Tool/Voice runtime，不改 Harness 4 文件。

- **交互模型**：主动计划新增 `interaction ∈ {text_message, voice_call}`（默认 `text_message`）。规划 Prompt 让模型按白名单选择并守规「语音通话不是默认项」；`_activeValidatePlanResult` 白名单校验，`_activePlanDefaults` 持久化 `interaction`。纯逻辑集中在新增共享核心 `assets/js/proactive-interaction-core.js`（UMD，浏览器 + Node 测试同源）。
- **主动文字**：`text_message` 走既有 `_activeExecuteAiPlan` → `generateProactiveMessage` → `_activeStoreAiPlanMessage`（chatMessages `source:'active_message'`），`interaction` 仅影响 prompt 短回合策略，不做二次调度。
- **主动语音呼入**：`voice_call` 计划由浏览器独占执行（`_activeExecuteVoiceCallPlan`；`_activeSyncAiPlan` 对 voice_call 不再 PUT companion，杜绝后台把它当文字消息双发）。生成短开场词 → 持久化交互事件（localStorage `ib_active_interactions_v1`，复用 `purgeExpired`/`isDuplicateEvent` 防重复）→ 调用 `IB.voiceCall.offerIncoming(ev)` 弹出来电卡片（头像/角色/开场词/接听/拒绝）→ 接听进入现有 Voice Runtime；拒绝/忽略取消计划并同步事件状态。
- **全屏通话 UI**：`voice-call.css` 改为沉浸式全屏（大圆形角色头像、角色名、状态、`voice-call-duration` 计时、`voice-call-wave` 波形、实时字幕、中断/静音/扬声器/挂断控制）；`InternalBeyond.html` 新增 `incoming-call-overlay` 来电卡片与 `startVoiceCallFor` 参数化入口。前端状态机（incoming/connecting/connected/ending）与 runtime 状态解耦，真实语音状态仍由 `bridge/voice-runtime.js` 同步。`bridge/voice-runtime.js` 新增 `greeting` 消息（复用同一 TTS 队列 + generation 护栏，让开场词可由 AI 说出）。
- **全局短回合策略**：新增 `assets/js/brevity-policy.js`（UMD，前后台同源——`communication.js`、`active-diary.js`、`active/model-client.js` 共 3 处注入）。`text` 1-3 句 / `proactive` 1-2 句 / `voice` 明显短于文本（1-2 句）；用户明确要求详细（`isDetailedRequest`）时整体跳过；`maxTokens` 仅作安全边界，不替代行为策略。
- **持久化与护栏**：语音转录/回复继续经 `sendChatMessage`（voiceCall）写入 chatMessages 并参与既有 summary/Auto-Memory；`generation`/`asrGeneration`/`interrupt`/TTS 队列/Stale 音频保护由既有 Voice Runtime 保持不变。
- **测试**：新增 `test_proactive_interaction.js`（36 项：交互模型/事件规范化/去重/状态机/时长/brevity）；`test-voice_runtime.js`、`test_voice_streaming.js`、`test_chat_smoke.js`、`test_active_diary_smoke.js` 全绿（runtime 0 异常）；`node test-all.js --quick` 全绿（static 4 + service 14）。

### 追加修复：通话工具栏重复麦克风按钮

全屏通话工具栏原先渲染两个麦克风图标（`voice-call-mic`=打断、`voice-call-mute`=静音切换），视觉重复。已合并为**单个麦克风按钮**（`voice-call-mute`，负责静音/取消静音）——移除 `voice-call-mic` 打断按钮（打断仍由 VAD 插话 `interrupt('barge_in')` 触发，非移除功能）；说话高亮 `.active` 与静音斜杠 `.vc-slash` 都落到同一按钮；`toggleMute` 更新 `micMuted`/`.muted`/title/aria。最终工具栏 = [ 麦克风 ] [ 扬声器 ] [ 挂断 ]。`test_chat_smoke.js` 新增 `voiceCall.singleMicControl` / `voiceCall.muteToggle` 断言；`node test-all.js --quick` 全绿。

## 2026-09-02 · 零命令 Windows 启动器（双击即起、幂等检测 + localhost 静态服务）

新增「双击即用」的本地启动基础设施：双击 `Start Internal Beyond.cmd` 自动拉起/复用本地服务与静态 Web 服务器并打开页面；**只通过真实健康端点判定服务是否已运行，绝不盲目重复启动**。

- **`launch-internal-beyond.js`**（Node 启动器）：①`node local-services-runner.js --json` 读取 Bridge/Active 真实 `/health`（`server==='IB Bridge'` / `service==='internal-beyond-active-messages'`），健康则复用；②仅当「未健康且无运行中 manager 进程」才拉起 `local-services-runner`（幂等，避免双实例）；③有界轮询等待就绪（默认 25s）；④`internal-beyond-server.js` 静态服务（`127.0.0.1:23120`，`/health`，默认 `server==='InternalBeyond Web'`），健康复用 / 冲突报错 / 未启动才拉起；⑤全部就绪才打开 `http://127.0.0.1:23120/InternalBeyond.html`；失败弹窗 + 写 `logs\launcher.log`，**不打开残缺页面**。
- **`internal-beyond-server.js`**：仅绑定回环 `127.0.0.1`，静态服务项目根，`/health` 身份端点，路径穿越防护；`EADDRINUSE` 以码 3 退出供启动器识别冲突。
- **AudioWorklet**：新增 `assets/js/voice-worklet.js`（静态模块），`call.js` 改为 `audioContext.audioWorklet.addModule('assets/js/voice-worklet.js')`（失败回退原 Blob 路径）；处理器逻辑与 VAD/打断/静音不变。已用真实 Chrome 验证 **localhost 下静态 worklet 模块可加载并注册**（`AudioWorkletNode('ib-voice-capture')` 创建成功，0 运行时异常）。
- **入口**：`Start Internal Beyond.cmd`（`start /min` 最小化窗口运行启动器）。
- **测试**：新增 `test_launcher.js`（service 组，15 项：静态服务身份/MIME/穿越防护、webServerState 健康/冲突/空闲三种复用决策、servicesHealthy、runner `--json` 身份解析）；`test_worklet_localhost.js`（browser 组，真实 Chrome：localhost 页面加载、`IB.voiceCall` 挂载、静态 worklet 加载+注册、0 异常）。`test_proactive_interaction.js`、`test_voice_streaming.js`、`test_voice_runtime.js`、`test_chat_smoke.js`、`test_active_diary_smoke.js` 均保持全绿。
- **不新建第二套 runtime**：静态服务只做文件伺服，不改 Chat/Memory/Tool/Voice runtime；Harness 4 文件未动。

### 升级：真正的「傻瓜式单击启动」— `启动 InternalBeyond.vbs`

把 Windows 推荐入口从 `.cmd` 升级为 **双击 `启动 InternalBeyond.vbs`**（无需接触 CMD / PowerShell / Node 命令或端口）。VBS 只做**编排**：定位自身目录（支持中文/空格路径、任意当前目录、桌面快捷方式）、`shell.CurrentDirectory` 切到项目目录、默认隐藏窗口（`--debug` 可见）、检测 Node（`where node.exe`，缺省弹原生提示并写日志后退出）、然后 `shell.Run("node.exe launch-internal-beyond.js", …)` 委托给**唯一真实启动逻辑**——不复制第二套实现。

- **`启动 InternalBeyond.vbs`**（新增，GBK/无 BOM——WSH 按系统 ACP 936 读取，用 UTF-8 BOM 会报「无效字符」）：`[VBS]` 阶段日志写入项目 `logs\launcher.log`；退出码透传（Node 缺省 → 1，成功 → 0）。
- **`launch-internal-beyond.js`**（唯一启动逻辑，沿用）：日志路径由 `%LOCALAPPDATA%\InternalBeyond\logs\launcher.log` 改为项目 **`logs\launcher.log`**（要求 7）；其余 Bridge 检测/复用/健康检查、Web 服务端口/超时/冲突、失败原生弹窗、成功后开浏览器、完成后退出等全部保持。
- **`Start Internal Beyond.cmd`**：保留为**兼容别名**，仍只调用 `launch-internal-beyond.js`（非第二套逻辑）；推荐使用 `.vbs`。
- **`.gitignore`**：新增 `logs/`（运行时日志不入库）。
- **验证**（真实本机执行）：`cscript 启动…vbs` 冷/复用均跑通（服务健康即复用、Web 首次启动后二次运行检测到已结束复用作 —— 0 重复）；`--debug` 路径可见运行并退出 0；**从任意不同当前目录**（`%TEMP%` + 中文/空格路径设计）启动正常；`logs\launcher.log` 记录节点实测全阶段；Web 23120、服务 23115/23114 健康端点身份吻合；工具调试验证后已清理我启动的 23120、保留用户原有 23115/23114 服务。`test_launcher.js` / `test_worklet_localhost.js` / `test_harness_boundary.js` / `node test-all.js --quick` 全部通过。

### 为启动器配官方图标：`IB-icon.ico` + 桌面 `InternalBeyond.lnk`

先审计素材库，复用**已有的官方品牌图标**，未重新生成任何图片。

- **候选**：`IB-icon.ico`（根目录官方图标，16–256 多尺寸）、`Gemini_Generated_Image_*.png`、`bg-*.jpg/png`、`game\portraits\*`、`game\sleep_bubble_*` 等。选 `IB-icon.ico`：它本就是正式 logo（钻石形 + 靛蓝 "IB" 徽标，小尺寸清晰、与项目蓝/深色视觉一致），且**已是 `.ico` 多尺寸**，无需转换成单尺寸 PNG。
- **绑定**：`启动 InternalBeyond.vbs` 本身无法直接设置 Windows 文件图标，故采用 Windows 快捷方式作为最终桌面入口：桌面 **`InternalBeyond.lnk`** → 目标 = `启动 InternalBeyond.vbs`、工作目录 = 项目根、图标 = `IB-icon.ico`。
- **可复现安装器**：新增 `create-desktop-shortcut.cmd`（幂等，双击运行即在桌面创建/刷新 `InternalBeyond.lnk`；移动项目后重跑重新指向）。纯 ASCII 内容 + CRLF，避免 cmd/GBK 编码问题。
- **启动逻辑完全不变**：`.lnk` 只是转发到 `启动 InternalBeyond.vbs`（GBK 无 BOM），底层仍复用唯一 `launch-internal-beyond.js`——Bridge/Active 检测复用、23120 Web 检测复用、自动打开 localhost、0 重复服务、失败原生提示、日志，全部不变。
- **验证**：`create-desktop-shortcut.cmd` 实跑创建 `C:\Users\<user>\Desktop\InternalBeyond.lnk`（Target=`<repo-root>\启动 InternalBeyond.vbs`、Icon=`<repo-root>\IB-icon.ico,0`、WorkingDir=项目根）；双击该 `.lnk` 实际跑通启动链路（Bridge/Active 复用、Web 拉起并健康、0 重复，测试以 `IB_LAUNCH_NO_OPEN=1` 抑制浏览器、测后清理 23120）。`test_harness_boundary.js` / `test_launcher.js` / `test_worklet_localhost.js` 未受影响。

## 2026-09-02 · 修复 MiMo 朋友圈图片注入 400「base64 data is not valid」

- **现象**：AI 朋友圈生成（`generateRoleMoment` → `callApiChat` → `_callApiChatOnce` openai 分支）对 `api.xiaomimimo.com/v1/chat/completions` 返回 400，`error.param = "messages[1] user content: the provided base64 data is not valid"`。
- **根因**：`assets/js/moments.js` `_momentsImagePayload` 提取 mime 误写 `(String(src.match(...)||[])[1])`——`String(数组)` 先把匹配数组转字符串，再 `[1]` 取的是**字符串下标 1**（`"data:..."` 的字母 `'a'`），而非匹配数组的捕获组 → **mime 恒为 `"a"`**，`image_url` 变成 `data:a;base64,/9j/…`，MiMo 无法识别 `a` 类型的 data URI → 400。base64 本身完全合法（`/9j/`、`validCharset=true`），纯属 mime 提取坏代码。
- **修复（2 处，各约 1 行）**：
  1. `assets/js/moments.js` `_momentsImagePayload`：`(src.match(...)||[])[1]` 正确取捕获组 + base64 去空白/剥重复 `data:…;base64,` 前缀；
  2. `assets/js/communication.js` `_adaptContentForApi`（openai 图片分支）：构造 `image_url` 时把 mime 强制为合法 `image/*`（`/^image\//i.test(p.mime) ? p.mime : 'image/jpeg'`）+ base64 去空白/剥重复前缀——wire 层兜底，覆盖任何来源的图片注入。
- **验证（官方端点，mimo-v2.5，经 FlClash:7890 代理直连对照）**：`data:a;base64,…` = 400（与上述报错逐字一致）；`data:image/jpeg;base64,…` = 200；修复逻辑真实请求 400→200 确认。
- **排查方法**：DevTools→Network→该 400 请求→Response 看 `error.param`；或临时在 `_adaptContentForApi` 打 `[IB-DIAG] img mime=…`（本次已移除）。详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) T40、[docs/multimodal-image-inject-notes.md](multimodal-image-inject-notes.md)。
- **此前"强制 MiMo 契约"改动**（`communication.js` `callApi` + `active/node-model-port.js`）为防御性、非本次 400 根因，保留。

## 2026-09-10 · P12 · Image Router + GPT Image 2.5 双模型路由与并发控制

给全部图片生成入口建立**统一策略层**：`producers → IB.imageRouter → Image Scheduler → 现有 _wsExecImageGen → provider`。
核心约束是**不为了接两个模型再造第二套图片执行链**——Router 只做任务识别 / 模型选择 / 优先级 / 资源控制，
真正的 provider 请求仍然是 `assets/js/workspace.js` 里那一个 `_wsExecImageGen`（本阶段只给它加了可选的
`opts.signal`（复用其既有 AbortController）与 `opts.quality`（仅 gpt-image 家族下发））。

**审计结论（插入层）**：真实图片 producer 只有两处——Chat 的 `<ws_gen_image>`（`_execWsOps`）与
Moments / AI 自主 Moments 配图（`_momentsMakeImage`）；Blog / Diary / Activity / Character Runtime 目前
**没有任何图片生成入口**（companion 只输出 `wantImage/imagePrompt`，由浏览器侧出图），图片编辑与参考图
链路尚不存在。全仓库只有一个 executor（`_wsExecImageGen`）、一个 provider 推断（`_imgResolveProvider`）、
一套 provider metadata（`provider-directory.js`），没有任何 semaphore / 队列 / 重试 / 取消系统——Router 因此
插在 executor 之上，而不是新建执行链。

| 文件 | 改动 |
|---|---|
| `assets/js/image-router-core.js` | **新增**：UMD dual-load 运行时中立核心（零 DOM/fetch/db）。`classifyImageTask`（结构化任务画像，文本线索仅补充）、`decideImageRoute`（Fast→Flare 永不升级 / Precision→Sunburst 永不降级 / Auto 按画像选择）、`decideImagePriority`（P0–P3）、`createImageScheduler`（global=2 / Flare=2 / Sunburst=1 / 每角色=1 / queueLimit=8 + aging 防饥饿 + 重复合并 + 队列溢出驱逐 + 后台冷却与降级 + 槽位 finally 释放）、`createImageRouter`、`IMAGE_ROUTER_DEFAULTS`（唯一配置点） |
| `assets/js/image-router.js` | **新增**：浏览器接线，注入现有 `_wsExecImageGen` / `_imgResolveProvider` / MB 决策缝 / `apiSettings['image_router']` 覆盖；导出 `IB.imageRouter` |
| `assets/js/middle-brain-config.js` | `imageMode` 配置 + Advanced Settings 新增 `Image Generation` 卡片（`Fast ─ Auto ─ Precision`，复用既有滑动组件）；新增 canonical 决策缝 `middleBrainImageMode()` |
| `assets/js/middle-brain.js` | `MB_PUBLIC_API` 追加 2 个 config 层键（`middleBrainImageMode` / `normalizeMiddleBrainImageMode`，**不挂 window 兼容别名**），门面 key 45 → 47 |
| `assets/js/workspace.js` | `_wsExecImageGen` 支持 `opts.signal/quality`；`_execWsOps` 增第 4 参图片上下文并让 `gen_image` 经 Router |
| `assets/js/moments.js` | 新增 `_momentsRouteImage`（经 Router，无绕过旁路）；`_momentsMakeImage` 传 source/background（手动发布 P1、AI 自主 P3） |
| `InternalBeyond.html` | 挂载两个新脚本（core → adapter，位于 middle-brain.js 之后）+ Image Generation 卡片 |
| `test_image_router.js` | **新增**：纯 Node 专项 85 项（路由/并发/优先级与防饥饿/失败与 abort 槽位恢复/队列溢出/重复合并/后台冷却与降级/auto 升级/telemetry 脱敏），自带看门狗防止用例挂起被 `process.exit(0)` 掩盖 |
| `test_image_router_smoke.js` | **新增**：浏览器最小冒烟 18 项（真实链路 + UI 策略切换 + 真实并发峰值） |
| `test_frontend_structure.js` | 追加 Image Router 结构守卫（不复制执行器/provider metadata/Middle Brain、producers 不得绕过 Scheduler） |
| `test_middle_brain_seam.js` / `test_middle_brain_integrity.js` | 门面 key 数 45 → 47、facade-only 集合追加 2 键（有意契约扩展） |
| `test-all.js` | 登记 `test_image_router.js`（static）+ `test_image_router_smoke.js`（browser） |

**行为边界（重要）**：双模型策略只治理 gpt-image 家族（配置为空或 `gpt-image*`）；provider 为 gemini/anthropic/deepseek
或用户显式配置了非 gpt-image 模型时一律 `provider_managed`（只做并发控制，**不改用户填的模型**）。
用户显式 Fast/Precision 永远高于 Auto Router；后台任务最多通过 aging 提升到 P1，永远不会超过用户主动编辑 P0。

## 2026-09-10 · P13 · Image Editing Runtime / Reference Image 生产接入

P12 的 Image Router 早已支持 `operation:'edit'` / `previousImage` / `referenceImages` / `multiTurnEdits`，
但**没有任何生产入口**（模型想改图只能重新生成一张）。本阶段把这一个缺口接通，全程不重写 Router / Scheduler：

```
Chat <ws_edit_image> → Image Reference Resolver → IB.imageRouter → Scheduler → 既有 _wsExecImageGen
                                                                        └─ 内部薄的 _wsExecImageEdit（edit wire format）
```

**审计结论**：图片消息的 canonical 表示就是 `chatMessages.images[]` 里的 `{dataUrl, base64, mime, name}`
（用户上传经 `compressImage` 压缩后同形；ICode 里同一条 dataUrl 作为文件内容存储）——**没有第二套图片结构，也没有稳定 imageId**。
`<ws_gen_image>` 链路：`_segmentAiText`（`_WS_OPEN_RE`）→ `_execWsOps` → Router → `_wsExecImageGen` → `_wsCollectGenImages` → `aiMsg.images` + `_ibImageDrain` + ICode。
provider 侧审计：OpenAI 兼容只有 `/v1/images/generations`（JSON）、Gemini 只有 `generateContent`，
**仓库内没有任何 edit endpoint / multipart / 图像输入**——因此编辑 wire format 是本阶段新增的最小扩展。

| 文件 | 改动 |
|---|---|
| `assets/js/image-edit-core.js` | **新增**：UMD 运行时中立解析内核（零 DOM/fetch/db）。`normalizeImage`（dataUrl / base64 / url / src / 对象 → 同一 canonical 表示 + 保留 lineage）、`checkBudget`（数量/单张/合计）、`pickPreviousImage`（explicit > attached > latest）、`buildEditRequest`、`lineageFor`、`IMAGE_EDIT_DEFAULTS`（唯一限额点：`maxReferenceImages=4` / `maxReferenceBytes=4MB` / `maxTotalReferenceBytes=8MB`） |
| `assets/js/image-edit.js` | **新增**：浏览器接线。读 `chatMessages` 历史与 ICode 图片文件、超限复用 `IB.moments._momentsShrinkDataUrl`、显式选中态（`selectImage` / 预览条 chip / 图片查看器「编辑这张图」按钮）、`apiSettings['image_edit']` 限额覆盖。**不选模型、不管并发、不调 provider** |
| `assets/js/workspace.js` | `_wsExecImageGen(opts.operation==='edit')` 委托薄函数 `_wsExecImageEdit`（复用 provider 推断/凭证/120s 超时/响应解析/用量计量）；新增 `_imgEditCapability`（能力判定）、`_imgEditRefs`、`_imgGeminiUrl` / `_imgGeminiGenerate` / `_imgPickOpenAIImage` / `_imgSizeOk`（生图与编辑共用的公共能力）；`_execWsOps` 增 `edit_image` 分支（经 `_wsBuildEditIctx` → Router，无旁路）；`_wsCollectGenImages` 透传 lineage；`_WS_STREAM_STARTS` + 流式卡 + 结果卡文案支持编辑 |
| `assets/js/communication.js` | `_WS_OPEN_RE` / `_segmentAiText` 解析 `<ws_edit_image>`（正文=修改要求，可选 `path`）；`_viewImageFull(src,image)` 增加「编辑这张图」；`renderAttachPreviews` 渲染选中态 chip；4 处 `_execWsOps` 调用点补传 `friendId/threadId/senderName/userMessageId` |
| `assets/js/site-operations.js` | `_IMGGEN_INSTR_BLOCK` 说明 `<ws_edit_image>`（模型不必传 base64/URL/messageId；连续改图默认改上一次的结果） |
| `assets/js/image-router-core.js` | 编辑请求把 `operation/previousImage/referenceImages` 一并交给**同一个** executor；telemetry 增 `operation/referenceCount/editDepth`；`IMAGE_REJECT_TEXT` 增 8 个编辑/参考图错误码 |
| `assets/js/moments.js` | 导出既有 `_momentsShrinkDataUrl`（参考图超限复用，不复制压缩算法） |
| `InternalBeyond.html` | 挂载 `image-edit-core.js` → `image-edit.js`（位于 image-router.js 之后） |
| `test_image_edit.js` | **新增**：纯 Node 专项 113 项（归一化/限额/选源优先级/lineage 链/多轮 A→B→C 第三步必须改 B/edit 路由与 Fast·Precision 覆盖/优先级 P0 与不抢占/并发上限/失败与 abort 槽位恢复/重复合并与溢出/错误文案） |
| `test_image_edit_smoke.js` | **新增**：浏览器冒烟 50 项（真实 `<ws_gen_image>`→A→`<ws_edit_image>`→multipart `/v1/images/edits`→B→再编辑必须以上一张 B 为输入；页面重载后仍可解析；capability guard 0 次请求；显式选中；参考图限额与缩放；并发上限；telemetry 脱敏） |
| `test_frontend_structure.js` | 追加 13 条 P13 结构守卫（解析层不选模型/不管并发/不调 provider、复用压缩 helper、标签顺序、能力不足不得偷偷重新生成、lineage 接通） |
| `test-all.js` | 登记 `test_image_edit.js`（static）+ `test_image_edit_smoke.js`（browser） |

**能力边界（capability guard）**：OpenAI 兼容 + `gpt-image*` / `dall-e-2` → `POST {origin}/v1/images/edits`（multipart，`image` / 多图 `image[]`）；
Gemini → `generateContent` + `inlineData`；`anthropic` / `deepseek` / `dall-e-3` / 自定义模型 → `IMAGE_EDIT_UNSUPPORTED` 且 **0 次 provider 请求**。
端点不存在（HTTP 404/405）同样报不支持编辑——**编辑失败绝不偷偷降级成重新生成**（"只改头发"语义会变）。

**多轮编辑**：`aiMsg.images` 上的可选 lineage（`imageId / parentImageId / generationType / editDepth / model`）随消息持久化，
所以第二步编辑以 B 为 `previousImage`、第三步以 C 为输入，形成 `A → B → C` 而不是 `A → B / A → C`。

## 2026-09-10 · P14 · API 页 Middle Brain 整块折叠（视觉占用优化）

API Settings 页的 Middle Brain 配置区（说明 / 启用 / Endpoint / API Key / Astra Cognitive Control / Model /
Reasoning / Processing / Image Generation / Character Integrity Guard 及后续所有 Advanced Settings）在窄屏与
默认状态下占用过高。本阶段把它收进**一个可折叠 section**，全程不动 Middle Brain contract、Image Router、
模型选择逻辑、reasoning / service tier / image mode 行为，也不重写 API 页面：

- **折叠头常驻**：`Middle Brain` + 动态摘要 `model · reasoning effort · processing(service tier) · image mode`
  + `Enabled / Disabled` 徽标 + chevron；点击 header 或 chevron、键盘 Enter / Space 均可切换。
- **只隐藏 body，不销毁 DOM**：收起后所有 input / slider / API Key 状态原样保留，再展开不重新初始化、
  不重复绑定 listener（`_mbCollapseBound` 幂等守卫）。
- **持久化复用现有设置存储**：`apiSettings` 私有 key `middle_brain_ui = { collapsed }`（与 `image_router` /
  `image_edit` / `bgAi` 同一套 IndexedDB 方式）；**不写 canonical `middle_brain` 配置**、不用 localStorage。
- **默认态**：无用户偏好时，配置不完整（首次配置 / 未启用 / 缺 endpoint·model·API Key）→ 展开；
  配置完整（已有用户）→ 收起；用户手动切换后其偏好优先，不因 `enabled=true` 强制展开。
- **动效**：`max-height + opacity + visibility` 过渡（非 `display:none`），`prefers-reduced-motion` 沿用
  `core.css` 全局降级；窄屏摘要允许换行但不把 header 撑到接近展开态高度。

| 文件 | 改动 |
|---|---|
| `InternalBeyond.html` | `#middle-brain-section` 内新增 compact header `<button id="mb-collapse-toggle" aria-expanded="false" aria-controls="mb-collapse-body">` + body wrapper `<div class="mb-collapse-body" id="mb-collapse-body">`；**内部控件逐字未动**（只包一层） |
| `assets/css/core.css` | 新增 `.mb-collapse-head / -title / -summary / -badge / -chev / -body` 折叠样式与过渡（复用既有 glass / accent token，未新增样式表，20 个 stylesheet 计数不变） |
| `assets/js/middle-brain-config.js` | 新增折叠状态机（`_mbCollapseApply` / `_mbRenderHeader` / `_mbHeaderSummary` / `_mbConfigIncomplete` / `_mbBindCollapse` / `_mbInitCollapse`）+ `apiSettings['middle_brain_ui']` 读写；`loadMiddleBrainConfigUI` 返回 Promise（折叠初始化纳入同一条链）；model / reasoning / speed / image / enabled 变化时同步刷新摘要与徽标 |
| `test_middle_brain_collapse.js` | **新增**：静态专项 35 项（DOM stub 驱动真实 config 层）：初始态、点击与键盘切换、aria、状态保持、API Key 不丢、刷新恢复、摘要动态、不重复绑定、无异常 |
| `test_middle_brain_advanced.js` | 追加 9 条真实浏览器（CDP）折叠 smoke：默认收起（`visibility:hidden` + 高度 0）、摘要随配置、header 紧凑、点击展开/收起、button 原生键盘语义 + 焦点保留、API Key 与 slider DOM 状态保持、`middle_brain_ui` 落盘与重新 load 恢复、重复 load 不重复绑定、过渡为 max-height/opacity 而非 display:none |
| `test-all.js` | 登记 `test_middle_brain_collapse.js`（static） |

## 2026-09-10 · P15 · Image Router 前端配置层（模型目录 / 路由绑定 / Settings UI）

P12/P13 已经让图片请求统一经 Image Router、让「编辑这张图」可用，但**没有任何配置入口**：
用户无法决定图片请求用哪个 API 配置、哪个模型，模型目录里也看不到 Image 2.5。
本阶段补齐「可见、可配、可工作」的配置层，全程不新建第二套 Secret Store / provider metadata / executor。

```
设置 → API → Image Router
   ├─ Image Generation：API Config + Model + Enabled + 备用通道
   └─ Image Editing  ：API Config + Model + Enabled + 备用通道
        ↓ 保存  apiSettings['image_router'].routes（与既有并发覆盖字段同 key 共存）
   IB.imageRouter.routeImageRequest → resolveRoute → route_model / dual_model 决策
        ↓ apiConfigId → 既有 apiConfigs（endpoint/apiKey/provider）；model → 唯一模型目录
   Scheduler → 现有 _wsExecImageGen → Provider
```

**审计结论（缺口）**：① 没有任何 Image Router 设置页/面板；② 图片模型散落在三处（`image-router-core.js` 的
`IMAGE_MODELS` 字面量、`workspace.js` 执行器里的 `|| 'gpt-image-1'` 回落、API 编辑器手填的 `imageGenModel`），
UI 与请求体可能不一致；③ 路由配置只有并发覆盖字段（`apiSettings['image_router']`），没有「用哪个 API 配置/模型」；
④ 配置问题只会变成 fetch 401/404，不告诉用户去哪修。

| 文件 | 改动 |
|---|---|
| `assets/js/image-models-core.js` | **新增**：唯一 canonical 图片模型目录（UMD，零 DOM/fetch/db）。每条记录含 `id / label / provider / family / tier / capabilities / wire / qualities / sizes`；含 **Image 2.5 的真实 id** `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`（证据：Vercel AI Gateway 模型页 `gpt-image-2.5-sunburst` 与 "GPT Image 2.5 Flare and Sunburst now available on AI Gateway" 变更日志），以及 `gpt-image-1` / `dall-e-3` / `dall-e-2` / `gemini-2.5-flash-image`；`listImageModels({capability})` 是能力过滤唯一实现，`tierModelId()` 是双模型档位唯一映射 |
| `assets/js/image-router-config.js` | **新增**：路由配置层（零 DOM/fetch）。`getRoutes`/`saveRoutes` 写 `apiSettings['image_router'].routes`（**保留** maxConcurrent 等既有字段）、`resolveRoute`（route → 执行器 cfg + 模型 + 备用通道 + 错误码）、`describe`（Settings UI 只读描述）。provider 推断与编辑能力判定复用执行器的 `_imgResolveProvider` / `_imgEditCapability` |
| `assets/js/image-router-settings.js` | **新增**：Settings UI（只做界面）。两条路由卡片（API Config / Model / Enabled / 备用）、能力过滤下拉、**「+ 新建」直接调用既有 `addNewApi()`**、当前实际路由展示（`Generation → API 配置 / 模型`）、折叠态 `apiSettings['image_router_ui']`、给 API 编辑器的生图模型输入框填同一份目录的 `datalist` |
| `assets/js/image-router-core.js` | 模型 id 改为从唯一目录派生（`tierModelId`）；新增 `route_model` 策略（显式模型最高优先，Fast/Precision 不能改它）、`imageModelProblem`（目录/能力校验）、`resolveRoute` 注入缝、备用通道重试（仅 `IMAGE_FALLBACK_CODES`）、`normalizeImageOperation`、telemetry 增 `apiConfigId/routeName/modelSource/fallbackUsed`、`IMAGE_REJECT_TEXT` 增 9 个配置类错误码 |
| `assets/js/image-router.js` | 注入 `resolveRoute`；导出 `IB.imageModels`（UI 唯一模型来源）与 `normalizeImageOperation` / `imageModelProblem` / `IMAGE_FALLBACK_CODES` |
| `assets/js/workspace.js` | 生图执行器失败返回补错误码（`IMAGE_PROVIDER_ERROR` / `IMAGE_TIMEOUT` / `IMAGE_ABORTED` / `IMAGE_ROUTER_PROVIDER_UNSUPPORTED`）；结果回传 `route` / `fallbackUsed`（上层不必猜实际路由） |
| `assets/js/social.js` | `loadApiSettingsUI()` 与 `saveCurrentApi()` 成功后刷新 Image Router 设置（绑定下拉立刻看到新配置） |
| `assets/js/moments.js` | 图片失败观测 `reason_class` 同时保留错误码与可读原因（`CODE:reason`），新错误码不抹掉可读信息 |
| `InternalBeyond.html` | API 页新增 Image Router 区块（两条路由容器 + 折叠头 + 保存按钮）；挂载 `image-models-core.js` → `image-router-core.js` → `image-router-config.js` → `image-router.js` → `image-router-settings.js`；生图模型输入框接 `datalist` |
| `assets/css/core/api-components.css` | 新增 `.ir-card / -head / -state / -grid / -select-row / -adv / -route-line` 等路由卡片样式（复用既有 token，未新增样式表） |
| `test_image_router_config.js` | **新增**：纯 Node 专项 48 项（模型目录/能力过滤/wire、路由归一与持久化不丢并发字段、inherit/bound/disabled/配置缺失/缺 Key/缺 Endpoint/不支持 provider/本地端点免 Key、模型能力校验、备用通道解析、Core 接线与 0 次请求、telemetry 脱敏、describe、错误文案） |
| `test_image_router_settings_smoke.js` | **新增**：浏览器冒烟 36 项（UI 真实存在 → 保存 → 刷新后配置仍在 → Generation/Editing 各用自己的 API 配置与模型发真实请求（含 multipart `/images/edits` 的源图字节）→ 改模型后 request body 同步改变 → 缺 Key/配置不存在/路由关闭明确报错且 0 次请求 → 本地端点免 Key 放行 → 备用通道重试一次） |
| `test_frontend_structure.js` | 追加 15 条 P15 结构守卫（脚本按序挂载、core/Settings 不得硬编码模型名、模型必须按 capability 过滤、只写 `apiSettings` 且只按 apiConfigId 引用既有配置、不得读取/渲染 apiKey、必须复用执行器判定、显式模型必须进决策、能力不足在发请求前失败、备用白名单、复用 `addNewApi()`、展示当前实际路由） |
| `test-all.js` | 登记 `test_image_router_config.js`（static）+ `test_image_router_settings_smoke.js`（browser） |

**解析语义**：`apiConfigId` 留空 → `inherit`（沿用角色 cfg，与 P12/P13 逐字一致，老用户无需重配）；
有值 → `bound`（完全使用该 API 配置的 endpoint/apiKey/provider，与"正在和谁聊天"解耦）；
`model` 留空 → `auto`（交回 Fast/Auto/Precision 双模型策略）；有值 → `route_model`（显式最高优先）。

**只拦确定不可用的配置**：路由关闭 / 绑定配置不存在 / 模型不在目录或不支持该操作 / 公网端点缺 Key →
明确错误码 + **0 次 provider 请求**；端点留空但 provider 有官方默认端点、本地与内网端点不填 Key → 放行并记警告
（local-first 与 Bridge 本地服务就是这种形态，不得判死）。

## 2026-09-10 · P18 · 模型目录时效审计（Model Catalog Freshness Audit）

P17 把「有哪些服务、怎么摆」收敛成一份真源，但**「新建配置默认用哪个模型」一直没人对着官方文档核过**：
`gemini-2.0-flash` 已被官方停用、`grok-4` 已于 2026-05-15 退役、Anthropic 自 Sonnet 5 / Opus 4.7 起
**移除采样参数**（照发 `temperature` 会 400）。本阶段先做只读取证，再只改「新建配置的默认值」，
并补上 runtime 真正需要的最小 model policy——**已有用户配置一律不迁移**。

```
provider-directory.js
   ├── PROVIDERS[id].model        新建配置默认模型（唯一真源）—— P18 改 3 个
   ├── MODEL_POLICIES             model id → 请求侧硬约束（目前只有 supportsSamplingParameters）
   └── MODEL_AUDIT                provider id → 审计状态（current / deprecation-risk / unverified）
        ↓ 读取面 modelPolicy / modelSupportsSamplingParameters / providerDefaultModel / modelAuditEntry
communication.js  _modelSupportsSampling(cfg) → 门控 3 处 anthropic temperature
ib-model-core.js  buildRequestBody（anthropic 分支）→ active/node-model-port.js 自动继承
```

**默认值变更（仅 3 个，均有官方取证）**

| Provider | 旧 default | 新 default | 依据 |
|---|---|---|---|
| Anthropic | `claude-sonnet-4-6` | `claude-sonnet-5` | 官方迁移指南：Sonnet 5 是 4.6 的 drop-in upgrade（2026-06-30 发布） |
| Gemini | `gemini-2.0-flash` | `gemini-3.5-flash` | 官方 Firebase AI Logic 文档把 `gemini-2.0-flash(-001)` 列入已停用模型；3.5 Flash 有官方 what's-new 页 |
| xAI | `grok-4` | `grok-4.3` | 官方 `docs.x.ai/developers/migration/may-15-retirement`：`grok-4` 系列 2026-05-15 退役 |

其余 11 个**保持原值**：`deepseek-v4-flash` / `kimi-k2.6` / `mimo-v2.5` / `qwen-plus` / `glm-4-flash`
官方仍可调用（`current`）；`gpt-4o-mini` / `doubao-seed-2-0-lite` 有官方弃用信号但缺官方 API 表
（`deprecation-risk`）；`MiniMax-Text-01` / `mistral-large-latest` / `yi-lightning` / `Baichuan4`
查不到官方来源（`unverified`）——**不猜替代值**。

**Claude 请求兼容（本轮最重要的边界）**：`MODEL_POLICIES` 登记 `claude-sonnet-5` / `claude-opus-4-7`
/ `claude-opus-4-8` / `claude-opus-5` 为 `supportsSamplingParameters: false`，请求不再发送
`temperature`；**表里没有的 model（含 `claude-sonnet-4-6` 与用户自填的未知 id）行为逐位不变**。
`communication.js` 三处 anthropic 请求体（`callApi` / 流式 / 非流式）与 `ib-model-core.js` 共用同一判定，
目录缺失时回落「照发」。

**不迁移已有配置**：只有 `onProviderChange()`（新建 API / 用户主动切 provider）会写 `#api-model`；
`editApi()` 从配置恢复并标记「非自动填入」，`saveCurrentApi()` 写表单值，启动 / 加载 / 保存链
都不改写 `model`。DeepSeek 的 `deepseek-v4-flash-vision-exp` **未删除**（精确匹配、无策略限制）。

**证据补充（2026-09-10，P18 交付后按用户提供的官方文档页复核）**：DeepSeek 官方「首次调用 API」
页（`https://api-docs.deepseek.com/zh-cn/`）的模型清单为 `deepseek-v4-flash` / `deepseek-v4-pro` /
`deepseek-v4-flash-vision-exp`，脚注说明前两者内部版本名（`DeepSeek-V4-Flash-0731` /
`DeepSeek-V4-Pro-0813`）**不影响调用 ID**，`deepseek-v4-flash-vision-exp` 为**实验性视觉模型**
（额外支持图片输入，模型名精确匹配即可调用，官方「图像理解」页有完整说明）。据此纠正 P18 报告中
「vision exp 查不到公开出处」的结论：`MODEL_AUDIT.deepseek.evidence` 改指该官方页，`status` 仍为
`current`；官方视觉约束（图片仅限 user 消息、仅视觉模型接受图片、JPEG/PNG/GIF/WebP 按内容判定、
单请求最多 600 张、单边最长 8192px / ≥15 张时 4096px）记入 `HANDOVER.md`。**未改任何默认模型、
未改任何请求行为。**

| 文件 | 改动 |
|---|---|
| `assets/js/provider-directory.js` | 3 个默认模型变更；新增 `MODEL_POLICIES` / `MODEL_AUDIT` / 4 个读取函数；MiniMax `docsUrl` 补齐 |
| `assets/js/communication.js` | 新增 `_modelSupportsSampling(cfg)`（委托目录）；3 处 anthropic `temperature` 赋值加门控 |
| `assets/js/ib-model-core.js` | `buildRequestBody` anthropic 分支加门控；导出 `modelSupportsSamplingParameters` |
| `test_model_catalog_freshness.js` | **新增**：P18 防漂移 68 项（审计覆盖 / 默认表锁定 / policy 语义 / vision exp / Claude 新旧策略 / 三处门控 / 新建与切换预填 / 不迁移 / 子进程无回归门） |
| `test_setup_wizard.js` / `test_api_onboarding.js` / `test_provider_presentation.js` | 「不复制默认模型」清单改为**从目录派生**（换默认值 / 新增 provider 自动跟随，不再人工同步） |
| `test-all.js` / `ARCHITECTURE.md` / `HANDOVER.md` | 登记新测试、补 P18 架构与已知限制 |

验证：`test_model_catalog_freshness.js` 68 ✔、`test_model_core_contract.js` ✔、
`test_provider_presentation.js` 104 ✔、`test_api_onboarding.js` 128 ✔、`test_setup_wizard.js` 86 ✔、
`test_diagnostics.js` 120 ✔、`test_harness_boundary.js` 42 ✔、`test_frontend_structure.js` ✔、
`test_astra_adapter.js` ✔、`test_call_acoustic_inject.js` 19 ✔；一次完整 quick regression 全绿。
浏览器：既有最小 smoke `test_api_key_mutation_repro.js` 全绿；另跑一次临时 CDP 冒烟 15 项全绿
（新建 Anthropic / DeepSeek / xAI 预填、`IBOnboarding.configure` 预填、legacy `claude-sonnet-4-6`
reload 与保存后不变、手改 model 不被覆盖、切 provider 取新默认、未知 model 不被替换、
页面内 `IBModelCore` 对 Sonnet 5 不带 `temperature` 而对 4.6 仍带）。该脚本写在 `logs/`（gitignored）验证后已删除。
本阶段**未**做动态模型发现、模型列表 / 价格、Model Registry、Model Router 改动、
Provider Presentation 架构改动，也未迁移任何已有配置的模型。

## 2026-09-10 · P17 · Provider 呈现层真源收敛（Presentation Convergence）

P16 把「怎么拿到 Key」讲清楚了，但**「IB 有哪些服务、以什么顺序摆、叫什么、给新手看哪句话」当时还有四份表**：
`InternalBeyond.html` 里 15 个硬编码 `<option>`、`setup-wizard.js` 的 `PROVIDER_ORDER` + `PROVIDER_HINT`、
`api-onboarding.js` 的 `OFFICIAL_ORDER` + `PROVIDER_HINT`，以及 `provider-directory.js` 自己那份
`ONBOARDING_ORDER`。四份表顺序各不相同（下拉是目录字面量序、向导是 openai 开头、获取向导是国内优先），
新增一个服务商要改四处、且极易漏改。本阶段把**呈现层也收敛到唯一目录**：协议配置早就是 canonical，
现在顺序 / 分组 / 文案 / 出现位置也只剩一份。

```
provider-directory.js
   ├── PROVIDERS              协议配置真源（endpoint/format/model/vision/streaming）—— 未改动
   ├── PROVIDER_PRESENTATION  呈现层真源（P17 新增，key = canonical provider id）
   │     order · group · kind · shortHint · showInPicker/Setup/Onboarding · capabilitiesKnown
   └── 读取面 providerPresentation / providerList / providerPickerList / setupProviderList /
              onboardingProviderList / pickerGroups / providerDisplayName / providerHint /
              providerBeginnerHint / providerCapabilitiesKnown / providerKind
        ↑                    ↑                        ↑
   social.js 下拉        setup-wizard 卡片        api-onboarding 官方卡片
   （optgroup 分组）     （无本地顺序表）          （无本地顺序表）
```

**删掉的四份重复表**：HTML 的 14 个 canonical `<option>`（只剩 1 个兼容模式 fallback）、
`setup-wizard.js` 的 `PROVIDER_ORDER` / `PROVIDER_HINT`、`api-onboarding.js` 的 `OFFICIAL_ORDER` /
`PROVIDER_HINT`、目录内的 `ONBOARDING_ORDER`（顺序改由 `presentation.order` 唯一决定）。

| 文件 | 改动 |
|---|---|
| `assets/js/provider-directory.js` | 新增 `PROVIDER_PRESENTATION` / `GROUP_ORDER` / `GROUP_LABELS` / `PRESENTATION_DEFAULTS` 与 10 个读取函数；删除 `ONBOARDING_ORDER`；`officialList()` 改为 `onboardingProviderList()`（presentation 驱动）；`providerKind()` 增 `'compatible'` 分支；`custom` 显示名改 `自定义 / OpenAI Compatible`（端点 / 模型仍为空，`vision/streaming` 旧默认不动） |
| `assets/js/social.js` | 新增 `_ibSyncProviderOptions()`（按 `pickerGroups()` 重建 `<select>`，optgroup 分组、`providerDisplayName()` 作文案、幂等、目录缺失时保留 HTML fallback）、`_ibSetProviderSelection()`（历史 / 未知 provider 补「未知服务商（id）」占位选项，绝不静默清空）、`_ibDefaultProvider()`；`addNewApi()` / `editApi()` 改走上述函数；`onProviderChange()` 增刷兼容模式说明位 |
| `assets/js/setup-wizard.js` | 删除 `PROVIDER_ORDER` / `PROVIDER_HINT`，改 `setupProviderIds()` + `providerHintOf()` 取目录（旧版目录才退到键序）；`__test` 导出相应调整 |
| `assets/js/api-onboarding.js` | 删除 `OFFICIAL_ORDER` / `PROVIDER_HINT`，改 `officialIds()`（目录 `onboardingProviderList()`）+ `providerHint()`；新增 `renderProviderNote()`：只对 `kind=compatible` / `capabilitiesKnown=false` 的服务说明「IB 不声明它的能力」 |
| `InternalBeyond.html` | `#api-provider` 只留 1 个 fallback `<option value="custom">`，其余由目录构建；新增 `#ibo-provider-note` 说明位 |
| `test_harness_boundary.js` | DOM 守卫收紧：先挖空字符串字面量再扫描（URL / 文案里的 `document`·`navigator` 不再误报），单列 `window['document']` 形态；新增 6 负例 + 8 正例自测（42 项） |
| `test_provider_presentation.js` | **新增**：P17 防漂移专项 104 项（顺序 / 分组 / 无第二份表 / HTML fallback / 下拉构建真实行为 / 临时目录副本验证新增与隐藏 / `custom` 语义 / 目录无重复协议真相 / boundary 正负例） |
| `test_api_onboarding.js` | 更新「HTML 硬编码 15 项」断言为 P17 语义；纯数据守卫断言改为「无 DOM 访问」而非「无同名单词」 |

**custom 的语义（本阶段明确）**：它不是某一家服务，而是 **Generic / OpenAI-Compatible 兼容模式**。
`providerKind('custom') === 'compatible'`，不进官方列表、没有官方 onboarding 条目（不给它官方站点）、
endpoint 与 model 均为空、`capabilitiesKnown=false`。底层 `vision/streaming` 仍是 `true/true`——
**有意保留旧默认**，因为改它会影响既有用户配置；能力未知这一事实改由呈现层声明 + 编辑器里一句人话
（「IB 不声明这个服务的能力…填完点『测试连接』就知道」）如实传达。

**验证**：`test_provider_presentation.js` 104 ✔、`test_api_onboarding.js` 128 ✔、`test_setup_wizard.js` ✔、
`test_harness_boundary.js` 42 ✔、`test_guide.js` 314 ✔、`test_frontend_structure.js` ✔、
`test_diagnostics.js` 120 ✔、`scripts_check_html.js` ✔；一次完整 quick regression（static 45 + service 16）全绿。
浏览器：既有最小 smoke `test_api_key_mutation_repro.js` 全绿，另跑一次临时 CDP 冒烟 12 项全绿
（下拉选项/分组/文案逐项等于目录、新建默认值、`onProviderChange` 预填、`custom` 说明位、
`editApi` 恢复选中、未知 legacy provider 占位、`IBOnboarding.configure` 预选）。
本阶段**未**改动任何模型 id、Model Router、wire format、API Key 存储，也未新增第三方站点。

## 2026-09-10 · P16 · 零门槛 API 获取向导（Guide / API 配置体验）

P4 的首次设置向导、P6 的零基础指南已经能让用户「照着做」，但**第一次听说 API Key 的人仍然卡在最前面一步**：
不知道自己该用哪家服务、不知道 Key 去哪创建、更不知道「接口地址 / 格式」是什么。本阶段把
「我没有 API Key」→「选服务 → 打开官方平台 → 创建 Key → 回到 IB 自动填好 → 只粘贴 Key → 测试连接」
这条路径补齐，全程不新建第二套 provider metadata、不新建第二套保存链、不削弱高级用户的完整手动能力。

```
API 页顶部（#api-onboarding-entry）
   ├─ 我还没有 API Key  → 获取向导（弹层）
   │      ├─ 官方 API 卡片（14 家，含任务要求的 8 家）
   │      │     · 一句人话：地区 / 是否要充值 / 适合谁
   │      │     · 「打开官网拿 Key」→ 官方平台（新窗口，安全 rel）
   │      │     · 「配置到 IB」→ 预填 provider/endpoint/model/能力 → 光标落在 Key 输入框
   │      └─ 第三方聚合 / 中转（视觉 + 语义独立分区 + 统一风险说明 + 状态标签）
   ├─ 我已经有 API Key  → 直接进编辑器（同样预填）
   └─ 导入 OpenAI Compatible API → custom provider 全手动
```

**审计结论（缺口）**：① API 页没有任何「我还没有 Key」的入口，只有「+ 添加API」；② `provider-directory.js`
只有名称 / 端点 / 格式 / 能力，没有任何「去哪注册、去哪创建 Key、地区与充值提示、几步教程」；③ 用户即使选对了
provider，仍需自己确认「接口地址」这类术语；④ 仓库没有第三方中转的接入说明，只有 error-catalog 里零散的「中转站」报错文案。

| 文件 | 改动 |
|---|---|
| `assets/js/provider-directory.js` | 新增 **keyed onboarding metadata**：`OFFICIAL_ONBOARDING`（14 家官方，按 provider id 关联，含 signupUrl / apiKeyUrl / docsUrl / regionHint / billingHint / audience / 3–5 步 guideSteps）、`THIRD_PARTY_SITES`（第三方聚合/中转，单点增删）、`THIRD_PARTY_RISK`（统一风险说明唯一一份）、`TAG_LABELS`（状态标签文案唯一一份）；新增 `onboardingEntry / officialOnboardingEntry / thirdPartyEntry / officialList / thirdPartyList / providerKind`。**不复制** endpoint / format / model / vision / streaming，保持 harness 级纯数据模块（无 DOM / window / fetch / require） |
| `assets/js/api-onboarding.js` | **新增**：入口分流 + 获取向导（弹层）+ 预填链路 + 外链安全。所有 provider 数据取 `PROVIDERS_DIR`，配置落地复用既有 `addNewApi()` / `onProviderChange()` / API 编辑器；**永不读取 / 生成 / 保存 / 拼接用户的 API Key**（只把光标放到 Key 输入框）；预填只写 endpoint/model，且带「自动填入」来源标记——用户手改过就绝不覆盖，编辑器里有正在编辑的内容时先确认 |
| `assets/css/api-onboarding.css` | **新增**：入口卡 / 向导卡 / 官方-第三方分区 / 状态标签 / 折叠教程 / 新手模式样式；只用 core.css 语义 token，运行时注入（不占 HTML 样式表预算），1040/860/640 三档窄屏 |
| `InternalBeyond.html` | API 页新增 `#api-onboarding-entry` 容器；API Key 标签旁新增 `#ibo-key-help`（「Key 在哪里获取？」）；接口地址标注「高级 · 一般不用改」并新增 `#ibo-guided-hint` 提示位与 `#ibo-compatible-hint`；挂载 `api-onboarding.js`（provider-directory → social → api-onboarding）；**9 处外链补齐 `rel="noopener noreferrer"`** |
| `assets/js/social.js` | `onProviderChange()` 给自动填入的 endpoint/model 打来源标记（用户输入即摘除），并刷新「Key 在哪里获取？」链接；`editApi()` 明确把既有配置视为用户数据（不打自动标记）。填值行为逐字未改 |
| `assets/js/setup-wizard.js` | 「填写 API Key」步新增「还没有 Key？点这里带你获取」→ 打开获取向导（数据仍取目录） |
| `assets/js/guide-beginner.js` | 「添加 / 配置 AI」章改为走新路径（带我获取 / 去粘贴）；FAQ 增「我还没有 API Key，从哪里开始」「别人卖我的中转 Key 能用吗」 |
| `docs/guide/annotations.json` | `08-api-entry` 的标注与说明改为「顶部是获取 API Key 的入口，+ 添加API 在页面中部」 |
| `test_api_onboarding.js` | **新增**：纯 Node + DOM shim 126 项（编码/挂载/单一数据源/官方-第三方分区/风险说明/metadata 缺失回落/预填与不覆盖/链接安全/回归守卫/移动端） |
| `test-all.js` | 登记 `test_api_onboarding.js`（static） |
| `CHANGELOG.md` | 本条 |

**官方 / 第三方怎么区分**：只依据目录里的显式 metadata（两张表分置 + `kind` 字段 + `providerKind()`），
**禁止**按域名或字符串猜测；第三方条目永不进入 `PROVIDERS`（不污染 Provider Core），接入时统一走
canonical `custom`（OpenAI 兼容），状态标签「IB 已验证兼容」只声明协议跑通，不含官方 / 安全 / 可信含义。

**本轮加入的第三方**：`OpenRouter`（公开文档的聚合网关，OpenAI 兼容、支持多模型，标 `未验证` —— 因为
IB 尚未实际跑通该服务的调用）与「我用的是别家中转 / 自建网关」（不绑定任何具体商家，只提供手动填写入口，
覆盖 one-api / new-api 这类自建网关）。第三方站点列表是单点数据结构，增删一家只改 `THIRD_PARTY_SITES`。

**安全**：外链一律 https 白名单 + `target="_blank"` + `rel="noopener noreferrer"`；URL 中一旦出现
`api_key / apikey / key / token / secret / password / auth` 等参数名直接拒绝渲染；模块零网络请求、
零存储写入、不记录 Key；普通提示不出现 Endpoint / Base URL / wire format 这类前置术语（只在「接口地址
（高级）」里保留，且新手模式下默认收起，字段仍在 DOM 中，高级用户随时展开）。

## 2026-09-10 · P19 · Anthropic Assistant Prefill 兼容修复

P18 留下的已知限制 ④ 在本轮修复：Anthropic 自 **Claude 4.6** 起不再接受「最后一条 assistant 消息作为
seed」（官方 400 `This model does not support assistant message prefill`；多个独立项目已在 4.6 上复现并改为
剥离尾部 assistant seed）。而 IB 的 Node 主动消息链（`active/moments.js` → `model-client` →
`node-model-compat` → `node-model-port` → `IBModelCore.buildRequestBody`）恰好用 `jsonPrefill` 给
anthropic 追加 `{"publish":` / `{"publishReply":` seed，且 `parsePlanJson` 依赖 seed 提供的开头 `{`
——**两个方向同时坏**：新模型直接 400，老模型返回的续写又缺 `{` 而解析失败。

```
jsonMode（业务意图：需要结构化 JSON）
        ↓  IBModelCore.buildRequestBody（anthropic 分支）
   MODEL_POLICIES[model].supportsAssistantPrefill
        ├── true  → 追加 {role:'assistant', content: seed}     ← legacy / 未知 model（行为逐位不变）
        └── false → 不追加 seed；注入一次 JSON-only prompt 约束 ← Claude 4.6+ / 5
        ↓
   active/node-model-port 透传 prefillApplied / prefillSeed
        ↓
   parsePlanJson(text, {prefillSeed})：完整 JSON → 围栏 → 受控续写 → 既有杂文容错
```

**MODEL_POLICIES 扩展（同一张表、同一个 lookup，无第二份能力表）**

| model | supportsSamplingParameters | supportsAssistantPrefill |
|---|---|---|
| `claude-sonnet-4-6` / `claude-opus-4-6` | 默认（true） | **false**（4.6 仍接受 temperature） |
| `claude-sonnet-5` / `claude-opus-4-7` / `claude-opus-4-8` / `claude-opus-5` | false（P18） | **false** |
| 其它（含 `claude-sonnet-4-5`、未知 id、`custom`） | 默认 | 默认（true） |

dated snapshot（`claude-sonnet-5-20260701`）与别名共用同一个 `modelPolicy()` 归一化，两项能力一起命中。

**请求侧**：不支持 prefill 时不发 seed，改为把稳定的一句话约束追加到**最后一条 user 消息**（不进
`system`，不污染角色设定与缓存前缀）；同一约束在重建 / 重试时**只出现一次**，consumer 已自带等价
JSON 指令（moments「只输出一个 JSON 对象」/ scheduler「只输出严格 JSON」）时**不插第二份**。
**普通聊天里的 assistant 历史永远不受影响**——受控的只有请求构造器自己追加的 seed。

**解析侧**：`parsePlanJson(text, opts)` 新契约 = A 完整 JSON（canonical）→ B ```json 围栏 →
C 续写（**仅当调用方给出真实 `prefillSeed`**，且只接受 `{` 开头的 seed，回填完整 seed 再解析；
绝不做全局 `'{' + anything` 修复）→ D 既有「首个 `{` 到末个 `}`」容错；malformed 一律 null。
Node 与浏览器两侧实现逐字同源，Node 侧新增 `prefillSeed` 透传（port → compat → model-client →
moments / scheduler / reply 链）。

**各 consumer 影响**：Moments（Node + 浏览器）→ 修复后正常；Active Messages（scheduler 二次评估）→
同样继承；Diary / Role Letters / Middle Brain → **零变化**（不是 jsonMode 路径或不经 core）；
普通 Chat → 无 JSON 指令、历史完整保留。

**顺手纠正**：P13 日期 `2026-09-11` → `2026-09-10`（工作树未提交内容不可能完成于未来日期）；
DeepSeek Vision 审计元数据已在上一轮按官方页纠正为 `current`，本轮只加防回归断言，未再改 runtime。

**Structured Outputs 可行性结论（只审计，未接入）**：Anthropic 已有官方结构化输出能力
（`output_config.format` / `json_schema`，旧的顶层 `output_format` + beta header 已进入过渡期弃用），
但 IB 侧目前只有 Astra/Responses 路径的 `middle_brain_result` 一个 schema，Moments plan / scheduler
evaluator 都只有「自然语言里写清楚的字段清单」而没有 schema 对象；把它升级为 schema-constrained
output 需要为每个 consumer 定义 schema + 处理不支持该能力的 model 的降级，**不属于「只差极小一步」**，
本轮不做。

| 文件 | 改动 |
|---|---|
| `assets/js/provider-directory.js` | `MODEL_POLICIES` 增 `supportsAssistantPrefill`（6 个 Claude 条目）+ 新读取面 `modelSupportsAssistantPrefill` |
| `assets/js/ib-model-core.js` | anthropic 分支按 policy 分流：seed / JSON 约束；新增幂等约束注入与等价指令识别 |
| `active/node-model-port.js` / `node-model-compat.js` / `model-client.js` | 透传 `prefillApplied` / `prefillSeed`（不改 content / reasoning 语义） |
| `active/plan-domain.js` / `assets/js/active-diary/active-plans.js` | `parsePlanJson` 新契约（两侧逐字同源） |
| `active/moments.js` / `active/scheduler.js` / `assets/js/reply-chain-core.js` | consumer 按端口声明决定是否允许续写解析 |
| `assets/js/social.js` / `InternalBeyond.html` | Temperature 控件按 policy 禁用 + 说明（**保留用户数值**），新增 `#api-temp-hint` |
| `test_anthropic_prefill_policy.js` | **新增**：75 项（policy / 请求构造 / parser 契约 / Moments 真实 prompt + 真实 port / 反回归） |
| `test_model_core_contract.js` / `test_model_catalog_freshness.js` | 契约随 P19 更新（legacy 用 `claude-sonnet-4-5`；shim 补 `_syncSamplingUI`） |
| `test-all.js` / `ARCHITECTURE.md` / `HANDOVER.md` / `CHANGELOG.md` | 登记新测试、P19 架构与已知限制、P20/P21 待办 |

验证：`test_anthropic_prefill_policy.js` 75 ✔、`test_model_core_contract.js` ✔、
`test_model_catalog_freshness.js` 68 ✔、`test_active_plans.js` 31 ✔、`test_moments_companion.js` 25 ✔、
`test_provider_presentation.js` 104 ✔、`test_api_onboarding.js` 128 ✔、`test_setup_wizard.js` 86 ✔、
`test_harness_boundary.js` 42 ✔、`test_frontend_structure.js` ✔；
浏览器 smoke（headless CDP，合成数据、无真实 Key）9 ✔：Sonnet 5 禁用滑块 + 提示 → 4.6 恢复 →
设 0.4 后切回 5 值仍在 → 真实保存后配置里 temperature 仍为 0.4 → 重新打开编辑器状态正确。

## 2026-09-10 · P20 · Anthropic Wire Contract 收敛（Browser / Node 单一归一真源）

P19 遗留的已知限制 ④ 在本轮修复，并把修复从「补一个 if」升级为**建立唯一的 Anthropic request
normalization**。原来的问题是 transport contract 层面的：Node 主动消息链把 consumer prompt 里自带的
`{role:'system'}` 原样留在 Anthropic `messages` 数组里（Anthropic 只接受 user / assistant），而 Browser
侧自己有一套就地归一（`find(role==='system')` + filter）——**同一个 provider 的 wire body 由两套不同
逻辑产出**，长此以往必然漂移。

```
Browser canonical messages[]            Node canonical {system, messages}
 （system 在数组内）                        （model-client 把 built.system 放进 spec.systemPrompt）
            │                                            │
            ▼                                            ▼
 communication.js _ibAnthropicWire()          IBModelCore.buildRequestBody()
            └──────────────────┬─────────────────────────┘
                               ▼
        IBModelCore.normalizeAnthropicMessages(prompt, spec)   ← 唯一真源（纯函数）
                               ▼
        { system, messages }（messages 只剩 user / assistant）
```

**不变量**：*Canonical IB messages may contain system messages. Provider adapters are responsible for
wire normalization. Anthropic wire messages never contain `system` role; system content is represented
using Anthropic's top-level `system` field.* 且 *Browser and Node must use the same Anthropic
normalization truth.* —— 修正方向**不是**禁止 consumer 产生 system。

**归一规则**（`normalizeAnthropicMessages`，Browser / Node 同一实现）：

| # | 规则 |
|---|---|
| 1 | 候选顺序 = 顶层 `system` → `messages` 里按出现顺序的 system |
| 2 | 完全相同（忽略首尾空白）的文本只保留一份 —— consumer 普遍把同一段 system 同时放进两处，去重后与 P20 之前的浏览器语义**逐位相同**（角色设定不会被投喂两遍） |
| 3 | 不同文本用 `'\n\n'` 连接（稳定分隔符，不 `join('')`；多条 system 一条不丢、顺序稳定） |
| 4 | 都没解析到时回落 `spec.systemPrompt`（与旧数组形态一致） |
| 5 | `messages` 只保留非 system 项，**逐条浅拷贝**（冻结输入也不报错） |
| 6 | 无法映射的 role（`tool` / `developer` / 自定义）**不静默删除**，保留原样交 provider 判定，并记入 `unmappedRoles` 供诊断 |

system content 的 canonical 契约是 **string**；block 数组 / `{text}` 只做最小安全兼容，**绝不**
`String(content)`（不产出 `[object Object]`）。新增纯诊断函数 `validateAnthropicRequestBody(body)`
（`messages-not-array` / `system-role-in-messages` / `unmapped-role:*` / `missing-model` /
`system-not-string`）——生产路径不据此抛错。

**收敛范围**：`communication.js` 三处 anthropic builder（`callApi` / 流式 `_callApiChatStreamOnce` /
非流式 `_callApiChatOnce`）统一经 `_ibAnthropicWire()` 转调同一个函数（核心未加载时明确报错，不静默
降级）；`active/node-model-port.js` 不自己处理 system（body 全部由 core 产出），Moments / Scheduler /
回复链 / Proactive 自动继承。**只共享纯请求形状归一**：fetch 生命周期、SSE 解析、AbortController、
retry UI、`cache_control` 断点、浏览器直连头、telemetry、Cache Audit 仍留在各自 runtime，core 保持
零 window / 零 DOM / 零 fetch（`test_harness_boundary.js` 继续锁死）。

**P19 policy 不回归**：Sonnet 5 不发 `temperature`、不发 artificial assistant prefill、jsonMode 走
JSON-only 约束；Sonnet 4.6 同样禁 prefill；legacy / 表外 model 保留旧 seed；dated snapshot 继续走同一个
`modelPolicy()`（normalizer 里不复制任何 model 判断）。JSON 约束仍然**只**追加到最后一条 user 消息
（不进 system、不污染缓存前缀），且没有因为「现在有统一 system normalizer」而搬家。

**tools / tool_choice / vision 结论**：Anthropic wire 上 `tool_choice` 两侧都不发送（Browser 只在
Cache Audit 里读它）；`tools` 仍由 Browser 的 IBFC / IBWS 提供、Node 端口不支持——属真正的 Tool Runtime
能力差异，**不在本轮范围**（未重构 Tool Calling）。图片块形状两侧一致（`{type:'image', source:{type:
'base64', media_type, data}}`），Browser 的 vision adapter 与 system 归一互不影响；Node 侧仍无 vision，
本轮**未**增加。

**明确未做**（范围纪律）：DeepSeek `/anthropic`、API config `format` / transport selector、Transport
Profiles、`/models` 探测、Model Registry / Marketplace、Structured Outputs 框架、Provider 默认模型改动、
用户配置迁移、Provider Presentation 改动、Tool Runtime / stream parser 重构、canonical storage 改动。
MIME 归一（BMP / SVG 栅格化）留给 P21，Transport Profiles 登记为 P22 Candidate，只读模型探测登记为 Future。

| 文件 | 改动 |
|---|---|
| `assets/js/ib-model-core.js` | 新增 `normalizeAnthropicMessages`（唯一归一真源，纯函数）+ `_systemText` + `validateAnthropicRequestBody`；anthropic 分支改为先归一再适配 content blocks |
| `assets/js/communication.js` | 新增 `_ibAnthropicWire()` 转调；三处 anthropic builder 删除就地 `find/filter(role==='system')`，改走同一归一（`cache_control` / `tools` / 流式标志等 transport 形状不变） |
| `test_anthropic_wire_contract.js` | **新增**：122 项（canonical contract / 归一规则 / role invariant / Browser×Node parity / P19 不回归 / 非 anthropic wire 不变 / 单一真源守卫） |
| `test_anthropic_prefill_policy.js` | 把「已知 Node 侧 system 透传」断言改写为 P20 契约断言（75 项仍全绿） |
| `test-all.js` / `ARCHITECTURE.md` / `HANDOVER.md` / `CHANGELOG.md` | 登记新测试、P20 架构与不变量、阶段重编号（P21 Native Vision / P22 Transport Profiles / Future Read-only Model Probe） |


验证：`test_anthropic_wire_contract.js` 122 ✔、`test_anthropic_prefill_policy.js` 75 ✔、
`test_model_core_contract.js` ✔、`test_model_catalog_freshness.js` ✔、`test_harness_boundary.js` 42 ✔、
`test_frontend_structure.js` ✔、`test_astra_adapter.js` ✔、`test_cache_audit.js` ✔、`test_llm_transport.js` ✔、
`test_role_letters.js` ✔、`test_active_plans.js` ✔、`test_provider_presentation.js` ✔、
`test_api_onboarding.js` ✔、`test_setup_wizard.js` ✔、`test_moments_companion.js` ✔、
`test_runtime_integration_audit.js` ✔；
浏览器 smoke（headless CDP，本地 mock server、合成配置、**无真实 Key、无计费请求**）：
`test_chat_smoke_provider_contract.js` 全绿（真实 `sendChatMessage → callApiChat → _callApiChatOnce` 链上
断言 anthropic body「顶层 system 为字符串 + messages 无 system role」）、
`test_runtime_convergence_moments.js` 0 failed（Moments 注入 system 消息后三协议 body 契约不回归）。

## 2026-09-10 · U1 · 更新发布契约（update-stable.json / Stable 通道）

Zero-Touch Update 的第一阶段。U0 只读审计确认：IB 有完整的「被更新」基础设施（覆盖安装、
身份归因停止、白名单载荷、失败回滚），但**产品侧没有任何「更新别人」的能力**——0 处版本检查、
0 个下载器、0 个 Update UI，且静默升级**刻意不重启**应用。U1 只做发布侧契约：先把「最新版是什么、
它的字节是什么」变成机器可读，其余交给 U2–U4。

**新增 `runtime/update-manifest.js`（唯一真源）**：schema（`internalbeyond.update` v1）+
**唯一** URL 构造 `installerUrl()`（构建期使用）+ 客户端 `validate()` / `parseInstallerUrl()`。
职责刻意分离：**构建端构造，客户端只校验/解析**，所以没有任何脚本或人能自己拼 tag / asset 名。
零依赖、无 fs、无网络、**无时钟**（有测试守着）。

**构建期（`build-installer.ps1` 新增第 7 步）**：EXE 与 SHA256SUMS 之后产出
`dist\update-stable.json`，三个值全部取自本次构建刚产生的字节——`sha256` 用第 6 步实测值、
`sizeBytes` 取实际长度、`productVersion` 从 exe 的 PE `VersionInfo.ProductVersion` **读回**并
必须等于 `VERSION`；再比一次 **清单 URL 的资产名 vs 本次真正产出的文件名**（ISCC 的
`OutputBaseFilename` 与 `installerAssetName()` 是两处独立拼写，只有拿真实字节比对才能钉死，
否则清单可能指向不存在的资产）。任一不符 → 构建失败：宁可不产出，也不产出和字节对不上的清单。

**诚实性**：`releasedAt` / `notes` 没有可靠的构建期来源，因此只在显式传参
（`-ReleasedAt` / `-NotesFile`）时写入，**没传就省略并告警，绝不编造时间戳**；
`-MinimumVersion` 可选。为守住"清单只能和同一次构建的 exe 一起发布"这条硬规则，
实测记录了同一 `VERSION` 两次构建字节不同（已发布 v1.0.0 = 50,724,579 B /
`5f7353b8…`；本机重建 = 50,788,752 B / `e46df857…`），写进发布手册。

**新增 `docs/RELEASE.md`**：发行契约唯一真源——产物清单、**发布顺序即契约**
（exe → SHA256SUMS.txt → update-stable.json **最后**；上传清单即进入 Stable 通道，
半成品发行对客户端不可见）、字段表、构建期闸门、发布复核三条等式、**安全边界**
（未签名：SHA-256 只证明「字节与清单一致」，**不是**发布者身份验证）以及分发可达性实测记录。

**U0 冻结决策入库**（DECISIONS 新增 U 系列）：U-D1 manifest 载体与发布顺序、U-D2 UI 落
Diagnostics（不新建页面）、U-D3 固定静默安装参数 `/IBRELAUNCH=1`、U-D4 检查/校验/semver/cache
以 Node 为唯一真源、U-D5 **重启由 Inno 完成、helper 绝不活过安装阶段**，外加全阶段安全不变量。
同时更正 D18：仓库当前是 **public**（实测 `"private": false`），"保持 private"一条失效。

**过程中发现的真实缺陷（已修）**：`edit` 工具剥掉 UTF-8 BOM 后，Windows PowerShell 5.1 按
ANSI 解码 `build-installer.ps1` 的中文提示，直接导致**整个构建脚本解析失败**
（`docs/TROUBLESHOOTING.md` T10 的又一次复发）。已补回 BOM，并新增静态守卫断言
`build-installer.ps1` 必须带 BOM——这类"文件损坏但测试全绿"的坑不能再靠人眼发现。

**分发可达性实测**（供 U2/U3 设计）：本机（中国大陆网络）`api.github.com` ✅、
`objects.githubusercontent.com` ✅、`release-assets.githubusercontent.com` ✅，
而 `github.com` / `raw.githubusercontent.com` / `codeload.github.com` ❌ 连接超时（10 s）。
即 `/releases/latest/download/...` 入口在部分网络不可达而 API 端点与资产落点可达。
结论：更新检查**绝不能进入 launcher 启动关键路径**，且一切网络失败必须 fail-open。

| 文件 | 改动 |
|---|---|
| `runtime/update-manifest.js` | **新增**：更新清单契约唯一真源（schema / 唯一 URL 构造 / validate / parseInstallerUrl / writeManifest + CLI `--write` / `--validate`） |
| `scripts/build-installer.ps1` | 新增第 7 步「update manifest」（8 步流水线 → 9 步）；新增 `-ReleasedAt` / `-NotesFile` / `-MinimumVersion` 及 preflight 校验；PE 版本读回与 URL 资产名比对两道闸门；summary 打印发布顺序 |
| `scripts/release-manifest.js` | 白名单新增 `runtime/update-manifest.js`（客户端要用，必须随包发行） |
| `tests/test_update_manifest.js` | **新增** 33 项：冻结身份、build() 诚实性（省略而非编造）、validate() 接受/拒绝矩阵、parseInstallerUrl、writeManifest 拒绝落盘、无执行面、依赖收敛 |
| `tests/test_installer_build.js` | 新增 [2b] 真实构建期清单断言 5 项（schema 有效 / hash+size 实测 / URL 版本固定 / 不编造时间戳 / 不进载荷） |
| `tests/test_installer.js` | 新增 [3b] 构建接线 8 项（含 BOM 守卫、清单步骤在 hash 之后、资产名绑定、可选入参 preflight） |
| `tests/test-all.js` | 登记 `test_update_manifest.js`（static，不联网、不安装） |
| `docs/RELEASE.md` | **新增**：发布契约唯一真源 |
| `docs/DECISIONS.md` | 新增 U-D1–U-D5 冻结决策 + 安全不变量；更正 D18 仓库可见性 |

验证：`test_update_manifest.js` 33 ✔、`test_installer.js` 46 ✔、
`test_installer_build.js --force` 15 ✔（真实 ISCC 构建 34 s，产出清单自校验通过，**未安装任何东西**）。

## 2026-09-10 · U2 · 更新检查运行时（U-D1 Revised 传输回退 + 24h 缓存 + fail-open）

Zero-Touch Update 第二阶段。U1 让"最新版是什么、它的字节是什么"变成机器可读；U2 把它变成
**产品真的会去问的问题**——并把这件事**完全放在 Node 侧**（U-D4：检查、manifest 校验、semver
比较、缓存全部由 Node 完成，浏览器只渲染；U4 的诊断页不得出现第二份实现）。

### U-D1 Revised（用户正式修订，原决策历史保留）

U1 期实测 `github.com` 连接超时，据此用户裁定：**主路不变**（仍是冻结的
`https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json`），
**只在主路连一个完整 HTTP response 实体都拿不到时**回退到 GitHub Releases API
（`GET /repos/yydye/InternalBeyond/releases/latest`，只接受 `draft === false`、
`prerelease === false`、资产名精确等于 `update-stable.json`，再经资产 API/CDN 取同一份清单）。
**拿到过响应就绝不回退**：404 / 403 / 429 / 非法 JSON / schema 不符 / hash 非法 /
identity 不一致 / 跳转出白名单，一律 hard failure → 如实降级为"本次无更新信息"，不换路径重试。
备路不是第二真源（两条路取到同一个 Release asset，共用同一套校验与比较），且**不引入任何
token / 登录 / 额外配置**。DECISIONS 以「U-D1 Revised」独立小节记录，未覆盖原文。

**U2 期更正（诚实记录）**：U2 实现期在同一台机器重测，`github.com` 已可达（302，1.6 s），
`raw.githubusercontent.com` / `codeload.github.com` 也恢复 200——U1 观测到的是**间歇性阻断**，
不是网络的稳定属性。这不削弱该修订，反而加强它（"有时通有时不通"正是必须有备路的情形），
同时说明 primary 应当保持 primary（常规路径更快、零 API 限额）。

### 新增

- **`runtime/update-check.js`（新增，检查运行时唯一真源）**：`check()` / `checkShared()`（单飞）、
  可注入 transport/时钟/缓存路径；真实 transport 手写 `https` 请求并**手动跟随后端跳转**，
  **每一跳**都校验主机白名单（`github.com` / `api.github.com` /
  `objects.githubusercontent.com` / `release-assets.githubusercontent.com`）——交给 HTTP 客户端
  自动跟随就会跟出白名单。回退门被压缩成一个可审计等式：
  `fallbackAllowed(result) === (result.outcome === 'network')`，`outcome` 只有
  `response` / `network` / `protocol` 三种。网络错误分类到冻结种类（dns / connect-timeout /
  reset / refused / unreachable / tls / socket）。永不抛出、永不给"非答案"；24h 缓存
  （**失败绝不缓存**、缓存写不进只是 warning、读回时重新校验，坏缓存只算未命中）；
  `summarize()` 给出 UI 用的固定投影（原始 manifest / attempts / warnings 不转发）。
- **更新模块是"可选依赖"**：静态服务对 `runtime/update-check.js` 用 **defensive require**——更新模块
  缺失/加载失败（半装、重构中的 checkout、改错的将来）时，服务器照常启动、`/__update-check`
  降级为 `update-module-unavailable` + `no-information`，**绝不让更新功能把整个 App 拖下水**
  （这正是"更新失败不得阻塞启动"这条冻结不变量的字面落实；有测试用 Module.require 注入
  加载失败来验证）。
- **`GET /__update-check`（`services/internal-beyond-server.js`，薄端点）**：启动时**不跑任何检查**
  （有测试守着：启动后 0 次）；`?force=1` 是手动检查（绕过并刷新缓存）；并发调用共用一次往返；
  异源 403（与 `/__shutdown` 同一守卫——否则任何网页都能花掉用户的 API 限额）、非 GET/POST 405；
  **永远 HTTP 200**，失败也在 body 的 `status` 里（UI 不该看到错误状态码）。
- **`product-version.compare()`（唯一 semver 比较）**：数值逐段比较（`1.10.0 > 1.9.0`，朴素字符串
  比较会搞反），非法输入返回 `null` 而**不是** 0——把"无法比较"说成"相等"会隐藏坏版本。

### 实测（真机联网，一次性验证，不进测试套件）

- primary 真实请求：`github.com` 302 → `.../v1.0.0/...` → **404**，因为已发布的 `v1.0.0`
  release **没有 `update-stable.json`**（该 release 早于 U1 的清单能力；API `digest`
  `sha256:5f7353b8…` 与 U1 记录一致，exe 未变）。客户端据此如实报 `no-information`，
  **不谎报"已是最新"**。
- **回退门被真实数据验证**：primary 的 404 是响应 → **一次都没碰 API**（换路也只是再失败一次）。
- **回退路径跑通**：注入 primary 网络失败（复现 U1 条件）+ API 真实请求 → API 返回真实 v1.0.0
  数据，`selectManifestAsset()` 以 `release has no asset named update-stable.json` 正确拒绝。
- API 匿名限额实测 `x-ratelimit-remaining: 57/60`。
- **结论（供 U3/U4）**：要让自动更新真正生效，必须先发布一个带 `update-stable.json` 的 release；
  在此之前 U2 的可观测结果只有 `no-information`——这是设计正确的失败姿势，不是缺陷。

| 文件 | 改动 |
|---|---|
| `runtime/update-check.js` | **新增**：检查运行时唯一真源（传输 + 回退门 + 错误分类 + 24h 缓存 + 单飞 + summarize） |
| `runtime/update-manifest.js` | 新增 U-D1 Revised 传输常量（`API_LATEST_RELEASE` / `API_VERSION_HEADER` / `TRANSPORT_HOSTS` / `assetApiUrl()` / `selectManifestAsset()`）；`ALLOWED_HOSTS` **未放宽** |
| `runtime/product-version.js` | 新增 `compare()`（产品内唯一 semver 比较）+ 消费方清单更新 |
| `services/internal-beyond-server.js` | 新增 `GET /__update-check` 薄端点（同源守卫、启动零检查、永远 200）；`shutdownOriginAllowed` 注释说明它现在守两个控制端点 |
| `scripts/release-manifest.js` | 白名单新增 `runtime/update-check.js` |
| `tests/test_update_check.js` | **新增** 50 项（不联网：transport 全部注入；服务器测试 patch 掉 `checkShared`，并注入一次 update 模块加载失败验证 fail-open） |
| `tests/test_update_manifest.js` | 33 → 38 项：新增 [8] 传输路由（冻结地址未被改动、API 端点、白名单、`assetApiUrl`、`selectManifestAsset` 严格接受/拒绝矩阵） |
| `tests/test-all.js` | 登记 `test_update_check.js`（static，不联网） |
| `docs/DECISIONS.md` | **新增「U-D1 Revised」**独立小节（原 U-D1 原文保留）；补记 U2 期可达性更正；写明判定等式 |
| `docs/RELEASE.md` | 新增 §2.1 客户端读取路径（一主一备的判定与白名单）；§8 改为"两次实测"并记录当前 Stable 通道实际状态（v1.0.0 无清单）+ 回退门/回退路径的实测结论 |
| `docs/ARCHITECTURE.md` | 模块树补两个 runtime 模块；§12 static 组补两条测试说明；**新增 §13 更新机制**（三个真源 / 检查路径 / 五条不可动摇的性质 / 端点对外形状契约） |

验证：`test_update_check.js` 50 ✔、`test_update_manifest.js` 38 ✔、`test_installer.js` 46 ✔，
受影响的相邻套件不回归：`test_boot_state.js` 37 ✔、`test_diagnostics.js` 120 ✔、
`test_launcher.js` 16 ✔、`test_installer_mock.js` 26 ✔（1 跳过）、`test_ib_stop_identity.js` 12 ✔、
`test_frontend_structure.js` ✔、`test_harness_boundary.js` 42 ✔。

## 2026-09-10 · U3 · 更新安装运行时（U-D6 载荷回退 + 四道校验 + detached 启动安装器）

Zero-Touch Update 第三阶段。U2 让产品**会问**「有没有新版本」；U3 让它**真的装上**。
整条链按 U-D5 切成两半：**helper 只做「下载 → 校验 → detached 启动安装器 → 立刻退出」**，
停止与重启全部留给安装器（只有安装器知道文件何时真的可替换）。

### U-D6 · Installer Payload Transport Fallback（用户冻结，独立新增决策）

U-D1 Revised 只管「读清单」。载荷走的是 `github.com`，在同样一些网络上是间歇不可达的，
所以把同一条规则扩展到 50 MB 级的 exe：primary 用 `manifest.installer.url`；**只有 primary
连一个完整响应实体都没拿到**（DNS/超时/重置/不可达/TLS/中途断流）才允许 GitHub API asset 备路，
且只接受 `draft === false`、`prerelease === false`、**tag 与 `manifest.version` 一致**、
资产名精确等于 `InternalBeyond-Setup-<version>.exe`。备路只是传输替代、不是第二真源。
HTTP 4xx/5xx · wrong asset · wrong tag · invalid Content-Length（缺失也算）· size mismatch ·
sha256 mismatch · PE 版本不符 · 任何安全校验失败 —— 一律 hard failure，**不换路、不重试**。
`asset.digest` 若存在必须等于 `sha256:<manifest.installer.sha256>`，不符即失败；缺失不算失败；
最终仍必须对本地文件重新计算 SHA-256。写入 `docs/DECISIONS.md` 时作为**独立新增小节**，
U-D1 / U-D1 Revised 原文一字未动。

### 新增

- **`runtime/update-install.js`（新增，安装运行时 + helper CLI）**：`startInstall()` 只从
  **自己已验证的缓存**（`update-check.json`，读回重新 `validate()`）解析安装对象，版本不符直接拒绝；
  载荷下载到 `%LOCALAPPDATA%\InternalBeyond\updates`（**运行期再检查一次绝不在 `{app}` 内**，
  越界配置直接拒绝而不是照做）；`.part` 流式落盘、边下边算 hash，全部校验通过才 atomic rename；
  任何失败都删文件；`spawnInstaller()` 用 U-D3 冻结参数数组 + `shell:false` + detached + unref；
  另有安装状态文件（`update-install-state.json`）与旧载荷清理。**不实现 stop、不实现重启。**
- **一次只能有一个安装**：状态文件不够——服务端 spawn helper 到 helper 写下第一行状态之间有个
  窗口，两次点击会变成两个 helper 往同一个 `.part` 写。改用独立锁文件（`update-install.lock`，
  `O_EXCL` 原子创建），成功后在**安装器的 pid** 名下续存（真正不能重叠的是安装），持有者消失或
  超时就接管，失败必释放——崩溃不会把功能永久锁死。
- **四道闸门**（全部在 `.part` 上完成，任一不过即删文件、不换路）：① `Content-Length` 存在、
  可解析、**恰好等于** `sizeBytes`（在**一个字节落盘之前**就判）；② 实际字节数等于同一个数；
  ③ 对**本地文件**重新计算的 SHA-256 等于 manifest 声明；④ 安装包 PE 身份
  （`ProductVersion` 字符串 + 固定 file/product 版本前三段）。
- **`runtime/pe-version.js`（新增，~230 行）**：有界定位读取（不整读 92 MB 文件）的
  PE `RT_VERSION` 读取器，同时支持 PE32 与 PE32+（Inno 产出的是 PE32）。抓的是哈希抓不到的
  那一类问题：**字节与清单一致、但文件根本不是那个版本**。九种具名损坏逐个拒绝，永不抛异常。
- **`runtime/update-transport.js`（新增，最小抽取，U-D6 item 9）**：U2 的 hop 遍历 + 每一跳主机
  白名单 + 网络错误分类 + `fallbackAllowed()` 移到这里，正文处理参数化为 **sink**
  （文本 sink = U2 原语义；文件 sink = U3 落盘 + hash）。**结果是全仓只有一处 `https.request(`**
  （有测试扫描 `runtime/*.js` 断言这一点），也没有第二份回退判定。新增可选的 stall 期限
  （按 chunk 重置，U2 不启用，行为不变；另加 `stallTimeoutMs` 只为大载荷存在）。
  U2 的 51 项原有测试一字不改地继续通过。
- **`POST /__update/start` + `GET /__update-status`（`services/internal-beyond-server.js`）**：
  start **只接受 `{version}` 一个字段**——出现 url / sha256 / path / hash / args 等任何字段一律
  **400 并点名该字段**（U-D6 item 7），服务端只用自己缓存里那份已验证 manifest，版本不符 409；
  接受后 detached 启动 helper 并立刻 202，**不等结果、不转发任何路径**。status 是安装状态文件的
  只读投影（永远 200，不含路径与 pid）。安装模块同样 **defensive require**：模块坏了服务器照常启动，
  两个端点降级为 `update-module-unavailable`。
- **`installer/InternalBeyond.iss`（安装器侧 relaunch）**：新增 `[Run]` 条目
  `Check: WantsRelaunch`，只有 `/IBRELAUNCH=1`（U-D3 冻结参数）才启动 IB——静默安装不会显示
  结束页，没有它 U3 装完就再也起不来了。普通交互安装的 `postinstall skipifsilent` 条目**一字未动**；
  内置运行时校验失败的安装不自动拉起（刚告诉过用户装坏了，再弹一个起不来的 App 只会更糊涂）。
- **`runtime/update-manifest.js`**：新增 `selectInstallerAsset()`（载荷版资产选择：tag 必须等于
  manifest 版本、资产名精确匹配、digest 交叉校验）、`normalizeDigest()`，并补导出
  `ASSET_PREFIX` / `ASSET_SUFFIX` / `normalizeSha256`。`selectManifestAsset()` 未改动。

### 测试

- `tests/test_update_install.js`（**新增 57 项，不联网、不安装**）：回退门（13 类 hard failure
  断言"一次都不碰 API"）、四道闸门、载荷绝不进 `{app}`、spawn 契约与状态文件、helper 只信自己的缓存、
  两个端点的完整拒绝矩阵、共用传输不回归。**载荷传输全部注入**（测试驱动真实 sink）；
  唯一的真实进程测试只启动 `node.exe`，用来证明 **detached 安装器比 helper 活得久**。
- `tests/test_pe_version.js`（**新增 13 项**）+ `tests/pe-fixture.js`（合成 PE32/PE32+ 构造器，
  可按名字损坏）：真实 `runtime/node/node.exe` 2 ms 读出 `24.18.0`，合成镜像覆盖 9 种损坏。
- `test_update_manifest.js` 38 → 41、`test_installer.js` 46 → 47（新增 U-D5 relaunch 静态检查，
  并交叉断言 helper 传的参数就是安装器读的参数）、`test_update_check.js` 50 → 51
  （新增"全仓只有一处 `https.request(`"守卫）。

验证：`test_update_install.js` 57 ✔、`test_pe_version.js` 13 ✔、`test_update_check.js` 51 ✔、
`test_update_manifest.js` 41 ✔、`test_installer.js` 47 ✔、`test_ib_stop_identity.js` 12 ✔，
**完整 static + service 回归 52 + 16 全绿（183 s）**。按 P7 测试预算：本期**没有**构建安装包、
没有安装、没有卸载、浏览器 0 次打开。

| 文件 | 改动 |
|---|---|
| `runtime/update-install.js` | **新增**：安装运行时 + helper CLI（缓存解析 / 下载 / 四道校验 / spawn / 状态文件 / 清理） |
| `runtime/update-transport.js` | **新增**：共用 HTTPS 传输（hop 遍历 + 主机白名单 + 错误分类 + 回退门 + 两种 sink） |
| `runtime/pe-version.js` | **新增**：PE 版本资源有界读取 + U-D6 版本闸门 |
| `runtime/update-check.js` | 传输/白名单/错误分类/回退门改为引用共用模块（公开面与行为不变，51 项测试原样通过） |
| `runtime/update-manifest.js` | 新增 `selectInstallerAsset()` / `normalizeDigest()`；补导出 `ASSET_PREFIX`/`ASSET_SUFFIX`/`normalizeSha256` |
| `services/internal-beyond-server.js` | 新增 `POST /__update/start` + `GET /__update-status`（含 4 KiB 有界 body 读取与 defensive require） |
| `installer/InternalBeyond.iss` | 新增 `/IBRELAUNCH=1` 门控的 relaunch `[Run]` 条目 + `RelaunchBlocked`（普通交互安装行为不变，BOM 保留） |
| `scripts/release-manifest.js` | 白名单新增三个 runtime 模块（少了任何一个，安装后的更新功能都会静默降级） |
| `tests/test_update_install.js` / `tests/test_pe_version.js` / `tests/pe-fixture.js` | **新增** |
| `tests/test_update_manifest.js` / `tests/test_installer.js` / `tests/test_update_check.js` / `tests/test-all.js` | 扩充与登记 |
| `docs/DECISIONS.md` | **新增 U-D6** 独立小节（U-D1 / U-D1 Revised 原文保留） |
| `docs/ARCHITECTURE.md` | §13 重写为含 U3（真源表 + 安装路径图 + 端点拒绝矩阵 + 四道闸门 + 共用清单 + 不可动摇性质扩到 8 条）；§12 static 组补两条测试 |
| `docs/RELEASE.md` | 新增 §2.2 载荷回退；§9 测试表补三行；说明 U3 同样需要先发布带清单的 release |

## 2026-09-10 · U4 · 诊断页更新体验（唯一用户可见更新界面）

给 Zero-Touch Update 补上**用户能看到的那一层**：诊断页新增一张更新卡片
（`assets/js/update-card.js`，通过诊断页新开的扩展卡位 `IBDiagnostics.registerCard(fn)` 注册）。
U4 **只渲染**——manifest 校验、semver 比较、传输与回退、SHA-256、PE 校验、安装器 spawn、
安装状态机全部仍然只属于 U1/U2/U3 的 Node 真源；卡片只读 `GET /__update-check` 与
`GET /__update/status`，只写 `POST /__update/start`，而且**只提交 `{version}` 一个字段**。

- **八个状态 + 两个结论**：`idle / checking / up-to-date / available / downloading / verifying /
  installing / failed`，外加启动时一次性判定的 `updated`（已更新到 x.y.z）与 `incomplete`
  （更新未完成，当前仍为 x.y.z + [重试]）。阶段与文案全部由后端投影决定，UI 不发明任何进度。
- **禁止假进度**：百分比只由状态文件里的真实 `bytes/totalBytes` 算出（13.0 MB / 50.2 MB · 26%），
  没有总字节数就只报已下载；刚点完「下载并安装」、helper 还没写下第一行时显示「正在准备下载更新…」，
  **一个数字都不给**。
- **服务消失 ≠ 更新失败**：一旦后端状态明确进入 `launching`/`launched`，卡片进入安装阶段并**锁住**。
  安装器在正常停止 IB 的过程中页面轮询必然读不到，此时只保留固定安装说明，绝不改判失败；
  只有后端**明确写下** `state=failed`（安装器起不来）才如实汇报并给 [重试]。
- **成功必须由版本证明**：安装器被 spawn ≠ 成功。开始安装时把目标版本写进 `ibUpdatePendingV1`
  （带 schema，仅本机浏览器存储），新实例启动后读一次「当前版本 vs 目标版本」：一致 → 「已更新到
  InternalBeyond x.y.z」，不一致 → 「更新未完成，当前仍为 x.y.z」+ [重试]，然后**立刻删除标记**，
  所以成功提示只出现一次。版本读不到时既不说成功也不说失败（静默消费）。
- **判定必须属于这一次尝试**：状态文件跨启动留存。卡片按「版本对得上 + 时间不早于本次尝试
  （2 秒容差）」判断这份 `failed`/`launched` 是不是我们的——否则用户点「重试」会在 helper 写下
  第一行的前 1~2 秒里读到上次的失败并误报。
- **文案**：内部 `kind`/`message` 只留在 `IBUpdateCard.status()` 里给诊断与日志，**不进 DOM**；
  用户可见文字只来自 U4 的两张分类表（install / check × network/corrupt/busy/stale/server/unknown）。
- **notes 纯文本**：远端 `notes` 只用 `textContent` 写入（`white-space:pre-wrap` 保留换行），
  全文件不出现 `innerHTML`——注入 `<img src=x onerror=…>` 在真实浏览器里只显示为文字。
- **修复一个真实的端点名错误**：U3 的两处注释把状态端点写成 `/__update-status`，而实现是
  `/__update/status`。U4 第一版照着注释写，真实浏览器里直接 404（Node 侧注入的 fetch 掩盖了它）。
  现在有一条测试把 UI 的三个常量与 `services/internal-beyond-server.js` 里的
  `pathname === '…'` 逐字对齐。

### 测试

- `tests/test_update_card.js`（**新增 192 项，纯 Node、不联网、不开浏览器**）：静态契约
  （不重实现任何 Node 真源 / 三端点逐字对齐服务端路由 / POST 体只有 version / notes 只有
  textContent / localStorage 只有两个键 / 不新建第二个页面 / P5 的 diagnostics.js 不被污染）、
  纯逻辑（状态→阶段 / 一次性判定 / 失败分类 / 字节格式化）、行为（八状态各自的文案与按钮、
  真实字节进度、XSS 防护、installing 后断开不误报、成功标记只消费一次、旧版本重开显示未完成）、
  文案禁底层术语（逐条扫描全部渲染结果与全部文案表），末尾以子进程跑
  `test_diagnostics.js` 与 `test_frontend_structure.js` 作为相邻回归。
- `tests/test_update_card_smoke.js`（**新增 38 项，真实 Chrome/Edge + 真实静态服务 + 真实状态文件**）：
  卡片真的挂在诊断页里、自动检查命中真实 24h 缓存并展示 notes、[下载并安装] 只提交 `{version}`
  （在页面里替换 fetch 拦截，**绝不触发真实安装器**）、真实进度与真实比例、安装阶段无百分比、
  **停掉服务后仍然是安装中**、环境零污染（无载荷文件、状态文件没有被真实 helper 改写）。
- 环境隔离：`IB_UPDATE_DIR` 与 `IB_BOOT_STATE_DIR` 全部指向临时目录，绝不碰 `%LOCALAPPDATA%\InternalBeyond`。

验证：`test_update_card.js` 192 ✔、`test_update_card_smoke.js` 38 ✔（真实浏览器）、`test_update_check.js` 51 ✔
（U2 的 51 项原样通过），**完整 static + service 回归 53 + 16 全绿（194.5 s）**。按 P7 测试预算：
本期**没有**构建安装包、没有安装、没有卸载、**没有触发真实安装器**。

| 文件 | 改动 |
|---|---|
| `assets/js/update-card.js` | **新增**：更新卡片（阶段派生 / 一次性判定 / 失败分类 / 唯一文本渲染点） |
| `assets/css/update-card.css` | **新增**：卡片样式（只用 core.css token，运行时注入，HTML 样式表预算不变） |
| `assets/js/diagnostics.js` | 新增扩展卡位 `registerCard(fn)` 与可等待的 `readProductVersion()`（版本仍是同一条链，不设第二份实现） |
| `InternalBeyond.html` | 新增一行 `<script src="assets/js/update-card.js">`（不新增样式表、不新增内联脚本） |
| `services/internal-beyond-server.js` | 两处注释把状态端点从 `/__update-status` 更正为真实路由 `/__update/status`（纯注释） |
| `tests/test_update_card.js` / `tests/test_update_card_smoke.js` | **新增** |
| `tests/test-all.js` | static 组登记 `test_update_card.js`，browser 组登记 `test_update_card_smoke.js` |
| `docs/ARCHITECTURE.md` | §13 补 `/__update/status` 投影形状、端点名陷阱、U4 体验小节（阶段表 + 不可动摇性质 9/10/11） |

## 2026-09-10 · U5 · v1.0.1 · 第一个可自动更新的正式版本

Zero-Touch Update 的发布阶段。U1–U4 让产品具备了「问有没有新版 → 下载 → 校验 → 安装 → 重启」
的完整能力，但它们**只存在于源码里**：已发布的 `v1.0.0` 早于全部 U 系列（tag → `23c8960`，
U1–U4 全在其后 26 个提交），那个安装包里没有更新清单、没有检查、没有下载器、没有更新界面，
服务端也没有任何 `/__update*` 端点。**结论（U5-0 审计实测）**：`v1.0.0` 是 legacy release，
其用户**无法**自动升级；想让自动更新真正生效，必须先正式发布一个带 `update-stable.json`
的 release——这正是 1.0.1 要做的事。

### 冻结的版本语义（U5-1 用户裁定）

| 版本 | 定义 |
|---|---|
| `v1.0.0` | legacy release：不包含 Zero-Touch Update，用户无法从该版本自动升级，**必须手动安装一次 1.0.1** |
| `v1.0.1` | **第一个正式包含 Zero-Touch Update 的 release**；1.0.0 用户手动装一次；此后作为真实 E2E 的 baseline |
| `v1.0.2` | **第一个由真实自动更新链到达的 release**；E2E 验证 `1.0.1 → 1.0.2` |

配套冻结：**不构建、不使用任何未发布的「1.0.0 updater seed」**（不伪造一个假基线，
基线必须是 GitHub 上的真实已发布资产）；`minimumVersion` 在 **1.0.1 省略**（1.0.0 根本没有
读取清单/更新端点的能力，写 `minimumVersion=1.0.0` 会是一句不成立的产品承诺），
**1.0.2 写 `1.0.1`**（届时它才第一次成为真实契约）。

### 本阶段改动（release preparation）

- **`VERSION` 1.0.0 → 1.0.1**（唯一版本源）。Guide 版本契约自动成立：`guideVersion` 取
  `MAJOR.MINOR`，`1.0.1` 仍是 `1.0`，因此 `annotations.json` 与 `guide-beginner.js`
  的 `VERSION_FALLBACK` **不需要改**（`test_installer.js [1]` 继续守着这条等式）。
- **`README.md`**：版本号与安装包文件名更新到 1.0.1（中文与英文两处），并**新增
  「升级到新版本」小节**——这是 1.0.0 用户唯一能读到的升级说明，必须明确写出
  「从 1.0.0 升级需要手动安装一次 1.0.1，从 1.0.1 起可在应用内更新」。
  README **随包发行**（白名单条目），所以旧版 README 会把用户指向一个过期的安装包文件名——
  这是必须随版本一起修的用户可见缺陷。
- **`docs/release-notes/1.0.1.md`（新增）**：面向普通用户的更新说明，同时是清单 `notes`
  字段的来源（`-NotesFile`）。**刻意使用纯文本**：`notes` 在 UI 里以 textContent 渲染，
  Markdown 标记会原样显示。全文不含 `U1`/`manifest`/`PE`/SHA 实现/`Node`/`endpoint`/
  `transport fallback` 等工程术语（只有 IB 自己的用户可见名词「API 配置」）。
- **`docs/RELEASE.md`**：§1 构建示例去掉 `-MinimumVersion`（与「1.0.1 省略」一致），
  §8 记录 Stable 通道发布进度与本节冻结的版本语义。

### 本次发布构建实测（四等式独立复核）

| 项 | 实测值 |
|---|---|
| 版本 | `1.0.1` |
| 安装包 | `dist\InternalBeyond-Setup-1.0.1.exe` · **50,828,077 B**（48.5 MiB） |
| SHA-256 | `4e5dc61a3ae36460feff188d5cc76b857cbf414c6552d24011e831ff06ca90d7` |
| PE ProductVersion / FileVersion | `1.0.1` / `1.0.1.0` |
| 清单 | `dist\update-stable.json`（version `1.0.1` · notes 605 字符 · **不含 `releasedAt`** · **不含 `minimumVersion`**） |
| 载荷 | [4] 审计 237 文件 · 0 error / 8 warn（全部是许可与 README 正文里的联系邮箱/电话，人工复核后不阻断） |

四条等式**全部独立于构建输出**、直接从磁盘字节重算（不是读构建打印的值）：

1. `manifest.installer.sha256` == SHA-256(exe 字节)；
2. `manifest.installer.sizeBytes` == 文件长度；
3. `manifest.installer.productVersion` == PE `ProductVersion` == `VERSION`；
4. `manifest.installer.url` 的**资产名** == 真实产出文件名（且 URL 版本钉死为 `v1.0.1`）。

另加：清单自校验 `validate().ok`、`releasedAt` 与 `minimumVersion` 确实缺席、`notes` 与
`docs/release-notes/1.0.1.md`（去 BOM 后 trim）**逐字相等**、无未知顶层字段、staging 已清理、
`manifest.installer.sha256` 与已发布 v1.0.0 的 digest 不同（不是同一个字节）。

**新鲜度证明（构建不陈旧）**：白名单 237 个载荷源文件中，**没有任何一个**的 mtime 晚于 exe 的
构建时间；且本阶段改动的四个文档（`CHANGELOG` / `RELEASE` / `HANDOVER` / `release-notes`）
**都不在载荷内**——因此它们可以在构建之后继续修改而不改变已构建的字节。
载荷内唯一承载产品版本的两个文件是 `VERSION` 与 `README.md`，两者都在构建前定稿。

### Gate 结果

`node tests/test-all.js --quick`：**static 53 项 + service 16 项全绿**（194.1 s）。
专项：`test_installer.js` 47 ✔、`test_update_manifest.js` 41 ✔、`test_update_check.js` 51 ✔、
`test_update_install.js` 57 ✔、`test_pe_version.js` 13 ✔、`test_update_card.js` 192 ✔、
`test_installer_mock.js` 26 ✔（1 跳过）、`test_guide.js` 314 ✔、`test_boot_state.js` 37 ✔、
`test_launcher.js` 16 ✔、`test_node_runtime.js` 18 ✔、`test_ib_stop_identity.js` 12 ✔、
`test_diagnostics.js` 120 ✔、`test_harness_boundary.js` 42 ✔、`test_frontend_structure.js` ✔、
`test_installer_build.js --force` **15 ✔**（真实 ISCC 构建 31 s，只构建、**不安装**）。

按 P7 真实安装预算：本阶段**没有真实安装、没有卸载、没有打开浏览器**。

版本号 bump 对既有契约的影响（已核实为零）：`guideVersion` 取 `MAJOR.MINOR`，`1.0.1` 仍是 `1.0`，
所以 `docs/guide/annotations.json` 与 `guide-beginner.js` 的 `VERSION_FALLBACK` **不需要改**；
`apps/catalog.json` 的 `"version":"1.0.0"` 是**单个 APP 的目录版本**（coread / cinema），
`services/ib-bridge-service.js` 的 `VERSION = '1.0.0'` 是 **Bridge 服务自己的版本**（诊断页单独展示），
两者都与产品版本无耦合，本轮**一字未动**。

### 发布前修正（纯文档 + 只重生成清单；安装包字节未动）

用户裁定「先修文档、再发布」，两项修正都不触碰已构建产物：

1. **`docs/RELEASE.md` §6 的错误论证被删除并更正。** 旧文写「同一份源码、同一版本号两次构建
   产出的 exe 字节并不相同（时间戳/压缩等因素）」，并用 v1.0.0 的两行数据作证。实测证明该论证
   是错的：**同一工作树、同参数、同工具链连续两次构建，字节数与 SHA-256 完全相同**
   （各 50,828,077 B / `4e5dc61a…90d7`）。那两行 v1.0.0 数据来自**不同的源码状态**
   （已发布 asset 出自 tag `v1.0.0` = `23c8960`；另一行出自当时 `VERSION` 仍为 `1.0.0` 但已含
   U1–U4 的 HEAD），64,173 字节的差额来自源码差异，**不能**证明构建非确定性。
   同时改为明确记录：**跨环境可复现性不得假设**（fresh clone / `core.autocrlf` / 工具链版本
   都会改变字节），而发布硬规则不依赖可复现性——exe + `SHA256SUMS.txt` + `update-stable.json`
   必须来自同一份已核验构建资产，上传后 GitHub asset digest 仍须独立交叉核对，
   **不得用重建产物替代原发布字节**。
   顺带实测并记录（供将来推理用）：该 exe 的 PE `TimeDateStamp` = `1770810027`
   （`2026-02-11T11:40:27Z`，**不是构建时刻**，构建发生在 `2026-09-10T11:11Z`）、`CheckSum = 0`；
   staging 用 `fs.copyFileSync`，mtime 不进入产出字节。
2. **最终清单省略 `releasedAt`。** 原先清单里的 `releasedAt = 2026-09-10T11:10:00Z` 是
   **构建时刻**，不是实际发布时刻；把 build timestamp 当 released timestamp 属于编造，
   与「绝不编造」规则冲突（`docs/RELEASE.md` §4）。因此最终发布清单**不含 `releasedAt`**，
   客户端因而不显示发布日期——这比显示一个假日期诚实。

做法：**只重生成清单，不重编译安装器**（`runtime/update-manifest.js --write`，输入值全部实测自
同一份 exe 字节：sha256 / sizeBytes / PE `ProductVersion` / `notesFile`，**省略 `--releasedAt`**）。
重生成前后 diff 只有一行差异（`releasedAt` 被删），`installer` 块逐字节相同：

| 项 | 修正前 → 修正后 |
|---|---|
| 安装包 `dist\InternalBeyond-Setup-1.0.1.exe` | **50,828,077 B · `4e5dc61a…90d7`（未变）** |
| PE ProductVersion | `1.0.1`（未变） |
| `update-stable.json` | 仅删除 `releasedAt` 一行；`validate().ok = true`；`notes` 605 字符未变 |

`docs/RELEASE.md` 与 `docs/CHANGELOG.md` **都不在 installer 载荷内**（白名单 237 文件已核实），
所以本次修正不需要、也没有触发重新构建。

### 发布结果（v1.0.1 已上线）

顺序严格按 `docs/RELEASE.md` §2 执行，**tag 指向发布时的 HEAD**，且该提交里已包含上述 §6 更正：

```
push master (8311942)  →  git tag -a v1.0.1 8311942  →  push tag  →  gh release create
  →  上传 exe  →  上传 SHA256SUMS.txt  →  交叉核对 digest/size  →  上传 update-stable.json（LAST）
```

| 资产 | 大小 | GitHub `digest` | 与本地核对 |
|---|---|---|---|
| `InternalBeyond-Setup-1.0.1.exe` | 50,828,077 B | `sha256:4e5dc61a…90d7` | ✅ == 清单 `installer.sha256` == 本地实测 |
| `SHA256SUMS.txt` | 406 B | `sha256:c53d29bc…6e38` | ✅ == 本地实测 |
| `update-stable.json` | 1,883 B | `sha256:a3ef3b27…5e90` | ✅ 在线回读与本地 `cmp` **逐字节相同** |

release 状态：非 draft、非 prerelease、`/releases/latest` == `v1.0.1`；上传后的在线清单
`--validate` 通过（0 error / 0 warning）。

**真实客户端只读实测**（`runtime/update-check.js` 真机联网；不下载、不安装、不写缓存）：

| 运行版本 | 结果 | 传输 |
|---|---|---|
| `1.0.0` | `update-available` → `1.0.1`；读到的 `sha256` / `sizeBytes` 与上表一致，`notes` 605 字符，无 `releasedAt` / `minimumVersion` | `direct` **connect-timeout 8 s**（本机 `github.com` 此刻不可达）→ `api` 200 |
| `1.0.1` | `up-to-date` | 同上 |

回退门（U-D1 Revised）在**真实数据**上被验证：primary 是网络失败（拿不到完整响应实体），
因此恰好换路一次，成功即止。**结论：Stable 通道自 `update-stable.json` 上传的那一刻起真实生效**；
U2 期记录的 `no-information` 状态自本次发布起不再成立（`docs/RELEASE.md` §8 已同步）。

发布过程仍遵守 P7 测试预算：**没有真实安装、没有卸载、没有打开浏览器**（0 消耗）。

## 2026-09-10 · U5-2A · 欢迎页画窗背景 payload 闭合（`bg-canvas.jpg` 随包发布）

U5-2 前置定位（只读）确认了一件事：欢迎页那张画窗背景在**安装版里一直是空的**。
冻结的根因不是路径写错——repo layout refactor（`e612197`）把四处引用全部改对了，
真实静态服务对 repo 与已安装 v1.0.1 都返回 200——而是**载荷契约缺口**：

- 画窗背景由 `glass-canvas.js` / `glass-ripple.js` 的**文档相对**探测链加载，顺序冻结为
  `assets/images/bg-canvas.png` → `assets/images/bg-canvas.jpg`；
- 6,268,353 B 的 PNG 原图**有意不入包**（`release-manifest.js` 的 `exclude` + `DENY_PATH` 双重规则）；
- 而 `bg-canvas.jpg` **不存在** → 安装版两个探测都 404 → 画窗退化成空雾玻璃；
- 仓库里（dev）PNG 存在，所以这个问题在开发机上永远看不见。

修法是最小闭合：**保留 PNG 作为仓库源图，新增一张同尺寸压缩副本随包发布**。

### 新增资产（未改动任何探测代码）

| 文件 | 前 | 后 |
|---|---|---|
| `assets/images/bg-canvas.png` | 6,268,353 B · 2600×1351 RGBA · `sha256=2203f12f…aa4ad` | **不动**（仍是仓库源图，不入包） |
| `assets/images/bg-canvas.jpg` | 不存在 | **新增** 921,213 B · 2600×1351 · progressive 4:4:4 · `sha256=f57a4751…d2217` |

转换参数与实测：`quality=90`、`subsampling=4:4:4`、`optimize`、`progressive`、保留原 DPI；
**同尺寸、不裁剪、不缩放、不加锐化/滤镜/调色**，只是丢掉 alpha 通道。
体积 **−85.3%（6.80×）**；与 PNG 解码后逐像素比较 **PSNR 41.28 dB**，最大差值 27/255，
差值 >12 的像素占 **0.0188%**（该图以 `background-size:cover` 在 ~1440px 宽、且叠了磨砂/色阶/水波层
的画窗里显示，源图按 ~0.55 倍渲染，肉眼无差）。

**alpha 审计（Phase 0 结论）**：没有必须保留的透明语义。PNG 虽然带 alpha 通道，但
99.7367% 的像素 alpha=255，非全不透明像素只有 9,249 个且**全部落在最外一圈 1px 边框**
（内部区域 alpha 仅 253–255 两个杂点）：左列 232、右列 234、上下行 232，即 0.91/0.92 的
1 像素边。该边又处在 `#gw-pane` 的 CSS 羽化遮罩最外沿（那里只有 0.34 不透明度）——
丢 alpha 带来的差异在最外 1 像素上约 3%，不可见。

### 明确**没有**改动的部分

- `glass-canvas.js` / `glass-ripple.js`：探测顺序、实现、注释一字未动（审计未发现顺序问题）。
- `scripts/release-manifest.js`：**零改动**。新资产经既有 `{ from: 'assets', dir: true }` 白名单
  自动入包，PNG 继续被既有 `exclude` + `DENY_PATH` 挡住。**不为"显式写出来"增加冗余规则**
  （新增测试专门守这条）。
- updater / U-D1 / U-D6 / 安装器更新流程 / `VERSION` / `v1.0.1` 的 tag·release·资产：全部未动。

### 测试

| 测试 | 覆盖 | 结果 |
|---|---|---|
| `tests/test_welcome_canvas_payload.js`（新增，static） | PNG 仍在且是同尺寸 RGBA 源图 / JPG 同尺寸且显著更小 / 两个脚本探测顺序逐字冻结 / **真实静态服务**对 repo 根 200（PNG 与 JPG，字节与磁盘一致）/ **安装态 fixture**（PNG 缺失 → 404，JPG 回退 → 200）/ **真实 staging** 产出 JPG、不含 PNG / manifest 未被加冗余规则 | 17 通过 |
| `tests/test_ui_regression.js`（browser，+4 项） | `#gw-slot.gw-has-img`（只在探测成功回调里加）→ 证明图**真的加载**；`--gw-ar` 被 JS 按解码尺寸覆写为 2600/1351；PNG 与随包 JPG 都能被浏览器解码 | 通过 |
| `tests/test_installer.js` / `test_installer_mock.js`（static） | 载荷契约 / 安装器 mock | 47 + 26 通过 |

回归入口已登记：`tests/test-all.js` 的 static 组新增 `test_welcome_canvas_payload.js`。

### 文档更正

`TROUBLESHOOTING.md` T9 与 `HANDOVER.md` 已知限制里那句「`bg-canvas.jpg` 404（背景图缺失）是无害噪音」
**已不成立**（当时它确实缺，现在随包发布），改写为事实：`bg-canvas.png` 404 是**预期**（6 MB 原图
有意不随包），由同目录压缩副本接住。`ARCHITECTURE.md` 的目录树同步标注 png/jpg 分工。

### 遗留（不在本阶段修）

**U5-2B 候选 · legacy cleanup**：`installer/InternalBeyond.iss` 没有 `[InstallDelete]`，
1.0.0（旧布局：背景图在仓库根）→ 后续版本在**同一目录**升级时，旧根级文件会残留。
不影响功能（新代码只按 `assets/images/` 探测），但会留死文件。已记入
`HANDOVER.md` 已知限制，**与本次视觉 payload 修复分开提交**。

## 2026-09-10 · U5-3 · v1.0.2 发布准备（第一个可自动到达的版本）

`v1.0.2` 只有一处用户可见改动——U5-2A 的欢迎页画窗背景随包发布——但它承担两个流程上的
第一次：它是**第一个由真实自动更新链到达**的版本，也是 `minimumVersion` 第一次真实写进清单。

### 版本与契约

| 项 | 值 |
|---|---|
| `VERSION` | `1.0.1` → **`1.0.2`** |
| 清单 `version` | `1.0.2` |
| 清单 `minimumVersion` | **`1.0.1`**（1.0.1 刻意省略：写 `1.0.0` 是一句不成立的产品承诺——1.0.0 没有读取清单/更新端点的能力，见 RELEASE.md §8） |
| 清单 `releasedAt` | **省略**（构建时刻不是发布时刻，RELEASE.md §4） |
| 用户升级说明 | 新增 `docs/release-notes/1.0.2.md`，同时就是清单 `notes` 的来源 |

`minimumVersion` 的语义借本次写清：客户端**只做形状校验，不据此拒绝安装**——它不是安装闸门。

### 构建（同一份源码的同一次构建产出三件产物）

| 项 | 实测 |
|---|---|
| 源码状态 | commit **`6d90c54`**，构建时工作树干净 |
| 命令 | `build-installer.ps1 -NotesFile docs\release-notes\1.0.2.md -MinimumVersion 1.0.1`（**不传** `-ReleasedAt`） |
| exe | `dist\InternalBeyond-Setup-1.0.2.exe` · **51,749,231 B**（49.4 MiB）· `sha256=508ee08f9001de7b…820591` |
| 载荷 | 238 文件 · 124,024,275 B · `release-audit` PASS（0 error / 8 warn） |
| PE `ProductVersion` | `1.0.2`（与 `VERSION` 一致） |

8 条 warn 全部是文档中**既有的**署名/联系方式命中（`README.md` 的作者 QQ/Email、
`InternalBeyond.html` 的 author-desc、`LICENSES/*` 的版权联系），本次改动一行未碰，非新增。

### 四条等式 + 载荷断言的独立核对

| 断言 | 独立证据 |
|---|---|
| `sha256` | `certutil -hashfile` **与** coreutils `sha256sum` 各自算出 `508ee08f…` == 清单 |
| `sizeBytes` | `stat` 实测 51,749,231 == 清单 |
| PE `ProductVersion` | PowerShell `VersionInfo` **与** `runtime/pe-version.js` 两个独立读取器都读回 `1.0.2` == `VERSION` |
| 资产名 / URL | 清单 URL 末段 `InternalBeyond-Setup-1.0.2.exe` == 实际产出文件名 |
| 背景图在包里 | `assets/images/bg-canvas.jpg` **存在** 921,213 B · `sha256=f57a4751…d2217`（与仓库源文件逐字节相同） |
| 原图不在包里 | `assets/images/bg-canvas.png` **不存在**（载荷内 `bg-canvas*` 只匹配到那一个 `.jpg`） |

清单本身再经 `runtime/update-manifest.js --validate` 自校验通过；`update-stable.json` /
`SHA256SUMS.txt` 均**不在**载荷内（各自 0 命中）。

**诚实边界**：载荷结论建立在**编译前那份 staging 字节集**之上——ISCC 正是用
`{#StagingDir}\*` 把这 238 个文件编进安装包的，构建脚本第 3/4 步（staging → 真实字节审计）
就是为此设的闸门。**没有**从已编译的 exe 反解文件表：Inno Setup 6 用 `lzma2/max` +
SolidCompression 保存条目名，包里搜不到 `bg-canvas.jpg` / `bg-canvas.png` 明文；本机做过
对照实验，**已发布的 1.0.1 安装包同样两者都搜不到**——说明该探测没有判别力，不能反过来
用来证明「文件不在包里」；本机也没有 `innoextract`。唯一能直接枚举**安装后**载荷的是
`test_installer_smoke.js --install-audit`，但本机已有真实安装的 1.0.1 baseline
（`E:\IB-E2E-1.0.1\InternalBeyond`），它与审计安装**共用同一个 AppId** `{78B427F6-…}_is1`：
审计安装会以同一 AppId 覆盖、并在卸载时删掉那条卸载注册表项，从而**破坏 E2E 的 baseline**。
因此本阶段刻意**不跑**该审计，安装后的载荷交给紧随其后的 `1.0.1 → 1.0.2` E2E 在真实安装
实例上直接核对。

### gates（构建前全部实跑，0 失败）

`test_welcome_canvas_payload` 17 · `test_ui_regression` ✓ · `test_update_manifest` 41 ·
`test_update_check` 51 · `test_update_install` 57 · `test_update_card` 192 · `test_pe_version` 13 ·
`test_installer` 47 · `test_installer_mock` 26（+1 skip）· `test_launcher` 16 · `test_boot_state` 37 ·
`test_node_runtime` 18 · `test_frontend_structure` ✓；
`test-all.js --quick` = static 54 + service 16 项全部通过（191.3s）。

### 明确**没有**改动

`apps/catalog.json` 的 APP 版本、Bridge 服务自身版本、`runtime/node/VERSION` 一律未动；
updater 的全部代码路径（`runtime/update-*.js`、`assets/js/update-card.js`）与 `v1.0.1` 的
tag / release / 资产一字未改；**不做 U5-2B**（不加 `[InstallDelete]`，legacy root-layout
cleanup 仍是独立后续项）。

### 用户说明的诚实取舍

需求里提到「改进应用内更新相关可靠性」，但 `v1.0.1..v1.0.2` 的差异**不包含任何 update 路径改动**
（`runtime/update-*.js` 与 `assets/js/update-card.js` 相对 v1.0.1 逐字节相同），所以
`release-notes/1.0.2.md` **没有**写任何关于更新可靠性的说法——只写了真实发生的欢迎页背景修复，
以及两条真实的升级路径说明。**宁可少写一句，不写一句没发生的事。**

### 发布（已按 RELEASE.md §2 顺序完成）

先 push `master`（到 `7e86c5e`），再打 tag **`v1.0.2` → `7e86c5e`**（显式 HEAD，不是 `gh` 的
默认 `target_commitish`）并 push，然后 `gh release create --verify-tag`（非 draft / 非 prerelease /
`Latest`）：

| 资产 | 大小 | GitHub `digest` | 与清单 |
|---|---|---|---|
| `InternalBeyond-Setup-1.0.2.exe` | 51,749,231 B | `sha256:508ee08f…820591` | ✅ 一致 |
| `SHA256SUMS.txt` | 406 B | `sha256:da520eff…a03a4` | — |
| `update-stable.json`（**最后上传**） | 1,519 B | `sha256:bbc4a396…e1c0c` | 在线回读与本地**逐字节相同** |

上传清单**之前**先做 digest 交叉核对（exe 的 GitHub `digest` == 清单 `sha256`、
asset size == 清单 `sizeBytes`、asset URL == 清单 `installer.url`），确认无误才上传清单——
**上传清单的那一刻，1.0.2 才进入 Stable 通道**。

真实客户端只读实测：`1.0.1` → `update-available` → `1.0.2`（读到 `minimumVersion = 1.0.1`、
`notes` 随清单下发）；`1.0.2` → `up-to-date`。其中一次运行的 primary（`direct`）
connect-timeout 8 s，**恰好换路一次**到 `api` 成功——回退门（U-D1 Revised）在真实网络失败上
第二次被验证。

`v1.0.1` 的真实安装实例（`E:\IB-E2E-1.0.1\InternalBeyond`）**保持不动**，下一步用它执行
`1.0.1 → 1.0.2` Zero-Touch Update E2E，并核对欢迎页画窗背景确实来自随包 `bg-canvas.jpg`。


## 2026-09-10 · R0 + U5-5 · 欢迎页水纹失效根因与 v1.0.3（第二个可自动到达的版本）

`1.0.1 → 1.0.2` 的更新链本身在真实安装实例上跑通了（升到 1.0.2、欢迎页背景恢复），却在收尾核验时
暴露了**另一处更早就存在的缺陷**：欢迎页的动态水纹特效整片不显示。因此 U5-4 没有给最终 PASS。
R0 只做定位、不动代码，根因冻结之后才提交修复。

### 根因：不在图片链路，而是一条渲染闸门

`assets/js/glass-ripple.js` 的 `idleNow()` 里有一条「离开欢迎页（`currentPage !== 'home'`）后暂停
逐帧水波模拟」的性能守卫。当深链把某个内容页设为打开页（实测 `#diagnostics`）、而欢迎页仍然可见时，
这条守卫让 `renderWater()` **每帧提前返回**：画布保持全透明、`#gw-slot` 永远不出现 `gw-rippling`。
同一页面的背景图走的是另一条**一次性 DOM 写入**路径（`glass-canvas.js`），所以它完好无损——用户看到的
就是「背景正常、水纹不动」。

| 入口（同一台机器、同一个已安装的 v1.0.2） | `#gw-slot` | 水纹非透明像素 | opacity |
|---|---|---|---|
| 启动器默认 URL | `gw-has-img gw-gloss gw-rippling` | 643,689 | 1 |
| 同一 URL + `#diagnostics` | `gw-has-img gw-gloss` | **0** | **0** |

三条独立证据排除了其它解释：

1. **因果翻转**：在不刷新的同一页面上**只**把 `window.currentPage` 改回 `'home'`，水纹立刻恢复
   （0 → 749,942 像素，opacity 0.9968）——渲染循环一直在跑，是守卫在提前返回；
2. **图片链路自证清白**：用 per-`Image` 栈记录证明两个消费端都真的走了 `png(404) → jpg(200)` 兜底，
   `naturalWidth/Height = 2600×1351` 解码成功（Chrome 把同 URL 的两个 `new Image()` 合并成一次网络
   请求，所以「只看到一个 JPG 200」不能推出「两个都成功」——本次用栈归属证明两个都成功）；
3. **没有异常被吞**：全程 `window.onerror` / `unhandledrejection` 捕获为 `[]`；`glass-ripple.js` 的 blob
   在 v1.0.1 / v1.0.2 / HEAD 三处完全相同，守卫自 `v1.0.0`（`6a61c3c`）就存在——**不是 U5-2A/U5-3
   引入的回归**，只是长期被「背景不显示」掩盖着。

### 最小修复与安全验证

`assets/js/glass-ripple.js` 删掉那一条守卫（commit `cbd798f`，`+5 / −3`，BOM 与 CRLF 原样保留）。
它想要的暂停**已经**由紧邻上方的 splash 判定覆盖：`hidden` / `dissolving` 任一成立即暂停，而画窗只可能
在欢迎页可见时被看到。实测确认这条覆盖成立——欢迎页可见时逐帧动画在跑，splash 隐藏后画面冻结
（`alphaSum` 1.8 s 内不变）。

修复后按**安装态载荷条件**验证（`bg-canvas.png` 请求失败、`bg-canvas.jpg` 兜底成功 + `#diagnostics`）：
`#gw-slot` = `gw-rippling`，水纹像素 654,025 → 735,897 → 829,778（逐帧变化），opacity 1，无控制台错误；
默认入口 URL 行为不变。

**本阶段未做**（保持最小边界）：`glass-ripple.js` 里 `loop()` 在 splash 曾 hidden 之后**永久死亡**的
隐患（`if(sp&&sp.classList.contains('hidden'))return;` 在 reschedule 之前返回）本次未触发、也未改动；
`prefers-reduced-motion: reduce` 下只渲染一帧空水位场的观感问题同样留待后续。

### v1.0.3 发布准备

| 项 | 值 |
|---|---|
| `VERSION` | `1.0.2` → **`1.0.3`**（发布提交 `c52eedb`） |
| 契约增量 | **无**：更新链、清单 schema、上传顺序、`minimumVersion`（仍 `1.0.1`）全部沿用 1.0.2 |
| exe | `InternalBeyond-Setup-1.0.3.exe` · **51,749,877 B** · `sha256=3345f461f1b52fd8…9434c` |
| 载荷 | 238 文件 · 124,024,430 B · `release-audit` PASS（0 error / 0 violation / 8 条既存 warn） |
| 载荷一致性 | 比 1.0.2 多 **+155 B**，与唯一改动文件的工作树字节差逐字节吻合；载荷内 `glass-ripple.js` 与 HEAD 相同且不再含 `currentPage` |
| 清单 | `minimumVersion=1.0.1`、**无** `releasedAt`、`notes` 531 字符 |
| 用户升级说明 | 新增 `docs/release-notes/1.0.3.md` |

四条等式用独立工具复核（certutil + sha256sum / `stat` / PowerShell `VersionInfo` + `runtime/pe-version.js` /
资产名 vs 真实文件名），清单经 `--validate` 自校验。载荷数字的**记法边界**已写入 RELEASE.md §8：本次构建
默认清理了 staging，数字来自构建**之后重新物化**的 staging（同源、同参数、同白名单，但不是被编译的那份
字节），安装后的载荷仍由 `1.0.2 → 1.0.3` E2E 在真实安装实例上核对。

### 发布后实测（v1.0.3 已上线）

`v1.0.3` 已按 RELEASE.md §2 顺序发布：先 push `master`，再打 tag `v1.0.3` → `666adc0`（显式 HEAD，
不是 `gh` 的默认 `target_commitish`），最后 `gh release create --verify-tag`（非 draft / 非 prerelease，
`Latest`）。三个资产 digest 与清单逐项交叉核对通过：

| 资产 | 大小 | GitHub `digest` |
|---|---|---|
| `InternalBeyond-Setup-1.0.3.exe` | 51,749,877 B | `sha256:3345f461…9434c` ✅ == 清单 `installer.sha256` |
| `SHA256SUMS.txt` | 406 B | `sha256:f3dda63a…6f77` |
| `update-stable.json` | 1,767 B | `sha256:3606e524…5014`（经资产 API/CDN 回读，与本地 `cmp` 逐字节相同） |

真实客户端路径实测（只读：不下载安装包、不安装、缓存写临时文件）：`1.0.2` 读到 `update-available`
→ `1.0.3`（`installer` 三字段与上表一致、`minimumVersion=1.0.1`、`notes` 531 字符）；`1.0.3` 读到
`up-to-date`。两次的传输都是 `direct` connect-timeout → **恰好换路一次** → `api` 200——本机此刻
`github.com` 被连接重置（`curl` 一个字节都拿不到），而 `api.github.com` 与资产 CDN 正常，
这是回退门（U-D1 Revised）第三次在**真实**网络失败上被验证。

### 安装态复核（U5-4 收尾）

`v1.0.3` 已在真实安装实例 `E:\IB-E2E-1.0.1\InternalBeyond` 上复核，**Welcome 水纹修复 4/4 通过**：
`/health` / `VERSION` / `boot-state.json` / 卸载注册表全部 `1.0.3`（全机仅一项安装）；安装目录
`assets/js/glass-ripple.js` = **10,687 B** · `sha256=1dc0a3f3…8b51`，与仓库 HEAD 及 HTTP 下发字节
三者逐字节相同、`currentPage` 0 次；`bg-canvas.jpg` 200 / `bg-canvas.png` 404 / `glass-canvas.js` 200；
安装器 20:43:59 停旧版本、20:44:02 用 `?ibv=1.0.3` 自动重启（launcher.log 上一轮为 `?ibv=1.0.2`）。
实际运行的安装包与已发布资产同源（51,749,877 B · `sha256=3345f461…9434c` == 清单 `installer.sha256`）。

**但这次升级不是应用内零触达**：安装器日志 `%TEMP%\Setup Log 2026-09-10 #003.txt` 的
`Original Setup EXE` 是 `C:\Users\admin\Downloads\InternalBeyond-Setup-1.0.3.exe`，命令行除 Inno 自身的
`/SL5="…"` 外无任何附加参数（无 `/SILENT`、无 `IBRELAUNCH`）；`%LOCALAPPDATA%\InternalBeyond\updates`
不存在、无 `update-install-state.json`、`update-check.json` 停在 20:08:51 且内容仍是 1.0.2 清单
（20:44 之前没有任何一次成功检查；失败从不写缓存）。同日 19:28 / 20:07 两次同为手动覆盖安装。

即：安装器那一半（停应用 → 覆盖 → 自动重启）真实跑过；**助手那一半**（读缓存清单 → 下载 →
大小 / SHA-256 / PE 校验 → detached 拉起安装器）与卡片到助手那一跳**仍未在真实点击下跑过**。

同日在真实安装态补做的检查（只写缓存，不下载不安装）：`GET /__update-check` → `fromCache=true` ·
`latestVersion=1.0.2`（陈旧缓存在 24h TTL 内遮蔽，只会少报）；`GET /__update-check?force=1` →
`transport=direct` · `latestVersion=1.0.3`，缓存刷新为 1,963 B / 1.0.3 —— **检查半程已通**，
只剩「卡片点击 → 下载 → 静默安装」未验证。U5-4 对 Welcome 修复判 **PASS**；零触达安装半程记为
**独立未结项**，等下一个有真实变更的版本做，不为测试单独发版。
