# InternalBeyond 编年史

> 本文记录 Internal Beyond 从上游原作到本仓库（fork）的全部演进。分两卷：
> **第一卷 = 上游卷（Sui 时代，InternalBeyond 1.x）**；**第二卷 = fork 卷（yydye 时代，2026-08 → 09）**；**第三卷 = 两卷对照**。
>
> 目录结构：与 [ARCHITECTURE.md](ARCHITECTURE.md)（怎么工作）· [CHANGELOG.md](CHANGELOG.md)（发明了什么）· [DECISIONS.md](DECISIONS.md)（为什么这么设计）· [HANDOVER.md](HANDOVER.md)（现状与待办）并列，互为索引。

---

## 0. 如何读本史（史料分级）

Internal Beyond 的"历史"其实来自**两类不同信源，可信度也要分开看**：

| 史料 | 来源 | 可信度说明 |
|------|------|-----------|
| **官方史料** | 公开的 README / LICENSE / CHANGELOG / DECISIONS / TROUBLESHOOTING / ARCHITECTURE | 面向外界、已落盘、可按文件与 commit 溯源 |
| **用户考古史料** | 维护者本人（作者）自述 | 一手、权威，但未落盘——**本史将其单独标注** |

> **两条铁律**（本史写作时遵守）：
> 1. 凡属"官方史料"的史实，都附以文件/commit 出处；
> 2. 凡属"用户考古史料"或**叙述性措辞**（修饰、比喻、定性），均单独标注 `［叙事］`，不与事实混淆。

---

# 第一卷 · 上游卷（Sui 时代 · InternalBeyond 1.x）

## 1.1 定位与出处

- **原作者**：Sui。版权 © 2025–2026 Sui。
- **上游地址**：<https://github.com/Sui-IB/InternalBeyond>
- **一句话定位（上游 README 原文）**："一个离线运行的单文件个人网站式前端项目，旨于维系情感的连续性。"
- **边界**：全部数据存本机（IndexedDB），**不依赖任何网络服务器**；无框架、无构建，直接打开 `InternalBeyond.html` 即可用。
- **永久免费开源**。

## 1.2 核心模块（上游 README：14 个）

| # | 模块 | 说明 |
|---|------|------|
| 1 | **Room** | 像素互动房间（1672×941），Sui 对话/茶歇/互动故事/塔罗/换装/休息 六子模块 |
| 2 | **Chat** | 多端口实时对话：浮动面板+全屏+群聊+图像生成+附件处理+Token 仪表盘+联网搜索+语音消息+Select/封档 |
| 3 | **Call** | 语音与视频通话：语音识别转写+逐句朗读+声学语气参考+视频直播间+弹幕+**五档礼物系统**+来电 |
| 4 | **Circle** | InternetBeyond 社交圈：用户与 AI 共同发布/评论/回复/转发，好友资料页、可见范围、搜索、配图与定位 |
| 5 | **Calendar** | AI 日历：悬浮小窗+挂历视窗，月相节气，AI 读取临近日程、AI 写入 |
| 6 | **Blog** | 日志/密码日记本/AI 评论/AI 批注/自定义剧本 |
| 7 | **Letters** | AI 书信——异步通信，AI 读你资料后写回信 |
| 8 | **Memory** | 长期情感记忆库：星图+自然衰减+上下文注入+Auto Memory（AI 自主记忆） |
| 9 | **Music** | 本地音乐播放器 + 48 条频率可视化波形 |
| 10 | **Profile** | 液态玻璃风格个人名片 |
| 11 | **API** | 多端口配置中心，最多 10 个独立 API |
| 12 | **ICode** | AI 代码工作区：文件管理/预览/内联编辑/沙箱运行/文档生成 |
| 13 | **DIY** | 透明立绘/占卜桌布/外部工具/MCP 服务器/**Internal Bridge**/沙箱扩展/文件解析库 |
| 14 | **Data** | 一键备份（全站导出/导入 JSON）、Token 用量仪表盘 |

> `［叙事］` 原项目 README 的表述已相当克制："两个方向都通往**边界之外**"——上游的自我气质是"一个可以住进去的、离线的情感空间"，而非一个工程系统。

## 1.3 双主题

- **Internal**（明亮/白天，棱镜彩虹光影）与 **Infernal**（暗色/夜晚，月光烛火）。均称 "IB"，只改变"向内 or 向深处"的方向。

## 1.4 生态：IB-Mobile（手机版）

- 上游另有兄弟仓库 **<https://github.com/Sui-IB/InternalBeyond-Mobile>**（手机版，`IB压缩版.html`，与电脑端共享数据）。
- `［史实限定］` **本仓库（fork）未派生 Mobile**——移动端完全属于上游生态，**不计入本 fork 谱系**。

## 1.5 AI 署名（官方）

上游 README 构建署名（**与本 fork 一字不差**，因为 fork 沿用同一份）：

```
构建：Claude (Opus 4.6) 构建 · Opus 4.8 / Sonnet 4.6 / Fable 5 / Opus 5 / ChatGPT 5.6 Sol 参与辅助构建
      GPT-IMAGE-2 贴图 · Adobe Photoshop CS 设计编绘
```

> ⚠️ **署名差异说明**：上游 README 列了 **Opus 5 + ChatGPT 5.6 Sol**；但 **`LICENSES/COPYRIGHT-NOTICE.md`** 只列 **4 只 Claude（Opus 4.6 / Fable 5 / Opus 4.8 / Sonnet 4.6，无 Opus 5 / Sol）**。此差异**上游也有、fork 是原样继承**，并非 fork 特有。`［叙事］` 这更像"README 署名更全、许可证通知更早/更简"的文档演进痕迹，不宜据此反推"哪只 AI 写了哪段"。

## 1.6 许可

- 程序代码：**PolyForm Noncommercial License 1.0.0**。
- 视觉素材与文档：**CC BY-NC-SA 4.0**（作者有权授权范围内）。
- 项目名称 / Logo / 作者标识：保留相关权利，不授权冒充官方版本。

---

# 第二卷 · fork 卷（yydye 时代 · 2026-08 → 09）

## 2.1 起手：为什么 fork

上游是**单文件、无后端、离线优先**。它的边界是"浏览器打开就能用"。本 fork 的增量几乎全部在回答同一个问题：**"浏览器关了之后，这个角色还要不要活着。"** 于是开始给它造地下的东西——一个能存持续性、能推送、能自言自语、社交圈离线续跑的本地机器。

这背后是一条**真实的决策曲线**（`DECISIONS.md` D18）：

```
2026-08-04  用户最初要求：不要提交、不要碰 GitHub
2026-08-14  建立本地 git 安全基线（全量测试绿才提交）→ 提交 800411d
2026-08-26  用户决定发布：创建 GitHub 私有仓库并推送，旧的"不碰远程"约束解除；
            同时坚持"仓库保持 private、敏感密钥永不入库"
```

`［叙事］` 所以这份工程化主要不是为开源，而是被"**一个人自己维护 6 万行原生脚本需要安全网**"逼出来的。

## 2.2 时间线（可追溯，挂 `CHANGELOG.md`）

```
2026-08-04  Bridge 后端诞生（ib-bridge-service.js 约1700行）｜首个交接对话｜主动消息雏形
2026-08-05~06  AI 自主规划主动消息 ｜ AI Diary 系统 ｜ Active UI 精修
2026-08-08  前端可维护性与回归基线：单文件拆分 assets/css + assets/js，test-ui 回归
2026-08-13  大拆分日：game/ 六文件 ｜ Bridge/Active 拆域 ｜ window.IB 命名空间迁移 ｜ test-all.js
2026-08-13~14  chat/workspace/memory 冒烟安全网 + 子模块提取（ENOENT 事故于此发生）
2026-08-14  Active/Diary 拆分 ｜ git 基线 commit 800411d ｜ core.css 12 段
2026-08-24  AI 朋友圈 Moments 第一阶段
2026-08-26  私有发布 ｜ Moments 二/三阶段 ｜ Social Net ｜ AI↔AI 回复链 ｜ 行为观测层
2026-08-27  TTS 第三阶段 A/B1/B2/C（MiMo builtin/voiceclone/voicedesign）
2026-08-28  朋友圈 motive 动机层 + declineStreak
2026-09-02  Proactive Interaction v1（主动语音呼入/全屏通话/短回合策略）｜ 零命令启动器（.vbs/.lnk）
```

**里程碑：同一套基础设施被压小**（`CHANGELOG.md` 记录）：

| 对象 | 一开始 | 后来 | 出处 |
|------|--------|------|------|
| `ib-bridge-service.js` | 约 1700 行 | 约 998 行（composition root） | 08-04 / 08-13 |
| `active-message-service.js` | 约 2021 行 | 268 行 | 08-13 |
| `communication.js` | 约 4840 行 | 约 3600 行（协调层） | 08-13~14 |
| `workspace.js` | 约 3380 行 | 1259 行 | 08-13~14 |
| `memory.js` | 2477 行 | 1704 行 | 08-13~14 |
| `InternalBeyond.html` | 约 2 MB 内联 | 入口HTML + assets（无构建） | 08-08 / 08-14 |

> `［叙事］` 一条清晰的弧线：**08-04 到 08 前两周几乎全在"加功能"；从 08-13 起几乎全在"拆分 + 建安全网"。** 这是从"可运行的站点"到"可维护的系统"的分水岭。

## 2.3 工程方法论（`DECISIONS.md` D4/D5/D6/D10/D16/D17）

| 主题 | 决策 | 出处 |
|------|------|------|
| **机械迁移** | 所有拆分不重排不重写：保持 IIFE 顺序、CSS 区段顺序、字节级一致（core.css 拆分后拼接与 `800411d` 原文件精确相等，359440 UTF-8 字节） | D5 |
| **双挂载过渡** | 函数/const 平挂 window；被重赋值的 var/let 用 `Object.defineProperty` getter/setter 转发 IIFE 局部绑定；内联 onclick 必须留 window | D6 |
| **冒烟安全网先行** | 大文件拆分前先写 CDP 冒烟套件锁定行为，每步提取后全量回归绿再下一步 | D17 |
| **失败原子性** | 提取/批改四步：先 mkdir → 先写新文件后改父文件 → 父文件前留备份/Git blob → 确认有回退副本 | D16 |
| **前后台零分叉** | 共享核心用 UMD 单文件（`reply-chain-core.js` / `social-observe.js` / `brevity-policy.js`），浏览器 `<script>` 与 Node require 同一文件 | D10 |
| **服务拆分约定** | composition root 拥有状态、模块拥有逻辑；可变状态留 root，被重赋值的用 getter/setter 注入；测试钩子重赋值 state 所以工厂一律 `getState:()=>state` | D4 |

## 2.4 被否决的方案（`DECISIONS.md` D15）

- ❌ **引入向量库做记忆/动态检索**：否决——"现有 bigram Dice 相似度 + 有界窗口足够"。（这也正面回答了"是否向量库"的疑问：**作者主动否了它，选择可解释的手写评分。**）
- ❌ RBAC / token 鉴权 / 用户隔离：违背个人本地应用定位（D1）。
- ❌ 恢复酷狗内嵌流式播放：服务端限制无解（D3）。
- ❌ 重写 moments.js 实现 Social Net：选择"新视图层薄 API + 旧服务函数复用"（D8）。
- ❌ 用 schema 提醒文字解决"输出解析失败"：诊断出根因是 reasoning 吃满 token，改为提额（D12）。

## 2.5 两件值得写进史书的事故

1. **ENOENT 数据丢失事故**（`TROUBLESHOOTING.md` T31 / `DECISIONS.md` D16）：08-13~14 提取 `memory/auto-memory.js` 时发生 ENOENT 丢数据，最终靠 **DSH 会话转录 + Cursor 本地 AI 记录**完整恢复后重做——直接催生 D16"失败原子性"铁律。`［叙事］` 是一张事故换一条军规的典型。
2. **MiMo 图片注入 400「base64 data is not valid」**（`CHANGELOG.md` 09-02 / TROUBLESHOOTING T40）：根因一行坏代码——`(src.match(...)||[])[1]` 把匹配数组 `String()` 转字符串后取下标 `1`，得到字符 `'a'`，于是 `image_url` 变成 `data:a;base64,...`。修复 2 处各约 1 行，并用真实官方端点对照验证 400→200。`［叙事］` 一行坏代码、一个 `'a'`、一个 400、一次逐字节定位——本工程线的最高分辨率瞬间。

## 2.6 开发阵容（**作者提供 · 一手考古史料**）

本 fork 的**实际开发阵容**与官方署名**差异极大**。以下由维护者本人（yydye）确认：

| AI / 模型 | 在 fork 里的痕迹 |
|-----------|-----------------|
| **ChatGPT / GPT-5.6 Sol / Terra / Luna** | 架构讨论、设计、Debug、功能规划、代码审查 |
| **Claude Opus 5 / Fable 5** | 大量工程实现、代码修改、复杂重构 |
| **Codex**（同 ChatGPT 系） | 工程实现、Harness、测试、修复、架构执行 |
| **DeepSeek V4 Flash / Pro / Flash-Vision-Exp** | 模型接入、Vision、API / 推理相关实验 |
| **Kimi** | 模型接入与测试 |
| **千问 Qwen** | 模型路由 / API 实验 |
| **GLM** | 模型能力、OpenRouter / 多模态相关实验 |
| **MiniMax** | 模型测试 / 路由实验 |
| **Gemini** | 图片支持 |
| **OpenRouter** | 多模型统一路由实验 |
| **Ox-Alpha / Stealth 等** | 后期模型路由实验 |

`［叙事］` 与官方署名的分野（详见 §3.2）：官方署名对外称 **Claude Opus 4.6 构建、Opus 5/Sol 辅助**；而 fork 真身是绕着一个**多模型工具链**跑完的——**Opus 5 / Fable 5 / Codex 干重活（工程+重构+Harness+测试）**，**ChatGPT 系做架构/规划/审查**，**DeepSeek 系做模型接入/Vision**，**Kimi/千问/GLM/MiniMax/Gemini/OpenRouter/Ox-Alpha/Stealth 做路由与多模态实验**。ChatGPT 5.6 Sol 是**唯一同时出现在官方署名与真实名单里的"桥梁"**。

## 2.7 当前形态（截至 2026-08-30 工作树）

- **入口**：`InternalBeyond.html`（无构建，`file://` 直接打开）。
- **两大本地服务**：Bridge（`ib-bridge-service.js`，23115）+ companion（`active-message-service.js`，23114）；Vision（可选，8765）；Web/启动器静态服务（23120）。
- **能力面**：主聊天（浏览器直连各家 API）、社交圈（AI 社交网络 + AI↔AI 回复链前后台）、AI 日记、记忆系统、工作区、游戏模块、行为观测层；全部注册 `window.IB` 命名空间。
- **测试基线全绿**：`node test-all.js --all`（static/service/browser 三组，约 150–165s）。
- **git**：基线 `e4074cc`、模块化检查点 `800411d`；2026-08-26 起发布到 **GitHub 私有仓库**。

## 2.8 近期工程：P1 声学语气参考 & P2 Video Runtime

围绕「**可复用的运行时锚点**」两条线，把上游 Call 模块里**耦合度低、自包含**的增量拆出来，以"先盘点、再搬/改/借逻辑"的方式落进 fork，**不照搬上游整个 Call**。

**P1 · 声学语气参考（Acoustic Mood Reference）**：
- 上游自带 `_vmToneAnalyze(ab, transcript)`，而 fork 的 `communication/voice.js` **早已移植同一算法**（用于语音消息路径）。发现后**没有再造一份**——而是**复用唯一核心**：在 `voice.js` 加 `_vmPcmToAudioLike()`（Int16@16k → AudioBuffer 兼容壳）作为 Call 路径的**唯一适配层**，`_vmToneAnalyze` 保持唯一算法核心不变。
- Call 路径（`call.js`）在 `onTranscript` 用 turn 累积 PCM 分析一次 → `acousticReference`；`communication.js` 加**request-local 缝**，把 `[Acoustic reference]…[/Acoustic reference]` 仅注入模型 `messages` 末条 user 的新对象，**绝不**进 `userMsg.content` / chatMessages / Memory / UI。
- 模型判定复用现有 `_vmAudioNative(cfg)` + `cfg.audioInput`；PCM 分析后**立即释放**。
- 产物：`docs/P1-ACOUSTIC-REFERENCE.md`；测试 `test_voice_pcm_adapter.js`（16）+ `test_call_acoustic_inject.js`（19）+ 端到端 CDP。
- **教训**：差点重复实现项目已有的 `_vmToneAnalyze`——仓库已有能力必须**先盘点**，否则违反 §3（禁止重复造轮子）。

**P2 · Video Runtime（独立视觉输入层）**：
- 新模块 `assets/js/communication/video-runtime.js`：**只管** `Camera→MediaStream→<video> 自预览→Frame Capture→Compression`，产出**原始帧** `{dataUrl,width,height,timestamp}`；压缩**复用** `communication.js::compressImage`（不重造）。
- **三层边界**：Video Runtime（纯视觉输入）/ Communication Runtime（帧→`_ibModelCanSee`→native image parts 或 本地 Qwen 描述→request-local 注入）/ Call Runtime（lifecycle·turn·UI 编排）。Video Runtime **不做** visionReference、不做模型路由、不持久化、不碰 LLM / Voice Runtime。
- **帧→LLM 复用既有路由**：把 `visionReference` 帧推进 `sentImages`，由 fork 既有 native/本地 Qwen 分支统一处理，**作用于 `messages`**（request-local），零新路由逻辑、零持久化。
- Call 编排：`call.js` 新增 `attachVideo(runtime)` + `onTranscript` 抓帧传 `visionReference` + `release()` 释放；并注入 **Call modal 视频面 UI**（相机开关 + 视频预览，不碰 `.voice-call-controls` 计数）。
- **本地 Qwen 定位**（已写入 `docs/VIDEO-RUNTIME-P2.md`）：`_describeImagesLocally` 是**「DeepSeek 还是瞎子」时期的补丁**；现在 DeepSeek 已有视觉（`deepseek-v4-flash-vision-exp` 原生），但本地 Qwen 路径**保留为非原生文本模型的兜底**，勿删、勿当"视频专用转文字"。
- 产物：`docs/VIDEO-RUNTIME-P2.md`；测试 `test_video_runtime.js`（14）+ `test_video_runtime_cdp.js`（11）+ 端到端帧路由 CDP（`vit.*`）+ 视频面 UI 断言（`videoUI.*`）。

`［叙事］` 这两条线是"把上游 Call 当**素材库**、按约束逐颗取用"的演示——**借逻辑、复用现有、request-local、绝不持久化**，而不是把上游整个 Call 抄进来。这也延续了 fork 一贯的"复用心而非重建"的工程风格。

---

# 第三卷 · 两卷对照

## 3.1 模块：保留 / 重定域 / 新增

| 模块 | 上游（Sui） | fork（yydye） | 说明 |
|------|------------|--------------|------|
| Room / Chat / Calendar / Blog / Letters / Memory / Music / Profile / API / ICode / DIY | ✓ | ✓ 保留 | 心没变 |
| **Call**（语音/视频+礼物） | 完整（含五档礼物、视频直播间） | 弱化为 Phase 1 语音通话（无礼物/无视频直播间全量） | 重定域 |
| **Circle**（用户+AI 圈子） | 完整 | 改为 AI 专属社交网络（Moments→SocialNet） | 重定域 |
| **Data**（备份/Token 仪表盘） | 独立模块 | 并入 API→数据保险（.ibvault 加密备份/健康检查/归档） | 重定域 |
| **Active**（主动消息/关页调度） | **上游无** | 新增 + 本地 companion | fork 增量 |
| **Moments**（AI 朋友圈→社交圈） | 上游用 Circle，无 Moments | 新增 + 多层（二/三阶段、motive、回复链、观测层） | fork 增量 |

`［史实限定］` 综上所述，**fork 不是上游的超集**，而是**平行重定域**：一样的心（Room/Chat/Memory/日历/书信/ICode），两类不一样的器官（社交与主动）。

## 3.2 官方署名 vs 实际开发阵容

| 维度 | 官方署名（README / LICENSE） | 实际开发阵容（作者自述） |
|------|------------------------------|--------------------------|
| 主力工程 | Claude Opus 4.6 主构建 | Claude Opus 5 / Fable 5 / Codex |
| 架构/规划/审查 | （未单列） | ChatGPT 系（5.6 Sol/Terra/Luna） |
| 模型接入 / 推理 | （未单列） | DeepSeek V4 全系 / Kimi / 千问 / MiniMax / GLM |
| 多模态 / 图片 | GPT-IMAGE-2（素材） | Gemini（图片）/ GLM（OpenRouter/多模态） |
| 路由实验 | （未单列） | OpenRouter / Ox-Alpha / Stealth |
| 对外署名清单 | Opus 4.6 + 4.8/Sonnet 4.6/Fable 5/Opus 5/Sol | —— |

> **结论**：官方署名是"本项目由 Claude 系构建"的**对外表述**；实际 fork 是绕着一个**多模型工具链**跑完的。二者并存、不矛盾，但**只有作者能写下真实那份**——本卷 2.6 即其一手的"考古史料"。

## 3.3 三代架构演化（`［叙事］`）

```
IB 1.0（Sui · 上游）    「个人 AI 网站」——单文件 · 无后端 · 离线 · 14 模块 · IB-Mobile
        ↓ fork 衍生
IB 2.0（yydye）        「多 AI + 本地世界」——多模型对话 · 主动消息 · 朋友圈 · 本地 Bridge
        ↓ 工程化
IB 3.0（yydye）        「本地 AI Runtime」——社会网/回复链/观测层 · 模块化 · 测试基线 · 私有发布
```

`［叙事］` 一句话收尾：**最初 IB 是让 AI 住进来的房间；后来房间被 fork 成了一个世界；再后来，给这个世界修起了基础设施——但它始终是一台单机、非 SaaS、本地优先的陪伴机，而不是一个操作系统。**

---

# 附 · 史料来源与证据链索引

- 上游 README：<https://github.com/Sui-IB/InternalBeyond>（唯一文档）
- 上游 Mobile：<https://github.com/Sui-IB/InternalBeyond-Mobile>（未派生）
- fork 文档：`README.md` / `ARCHITECTURE.md` / `CHANGELOG.md` / `DECISIONS.md` / `HANDOVER.md` / `TROUBLESHOOTING.md` / `LICENSES/`
- fork git 关键点：`e4074cc`（baseline）、`800411d`（模块化检查点）、`bbafba5`（声明衍生与上游出处）、`e3c2f01`（社交网络/回复链/观测层/docs 重组）
- 一手考古史料：开发阵容（§2.6）、模块数口径、个别决策动机——由维护者本人确认
