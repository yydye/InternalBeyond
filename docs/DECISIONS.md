# Internal Beyond · 设计决策

> 本文档回答「为什么要这么设计」。机制细节见 [ARCHITECTURE.md](ARCHITECTURE.md)，历史见 [CHANGELOG.md](CHANGELOG.md)，相关踩坑见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
> **这些是"不要随便改，因为当初就是这么设计的"的内容。**

## D1. 个人本地应用定位（最高约束）

- **个人本地应用**（Windows 单机 + 可选本机 companion 服务），不是 SaaS。
- **不引入** RBAC、用户隔离、token 鉴权、复杂认证等企业级设计；安全审查只聚焦本地可靠性（状态一致性、防重复、崩溃恢复、数据损坏、API Key 泄露、本机安全）。
- 保持实现简单，不为假设的公网/多用户部署增加复杂度。Moments 的 visibility（all/user/roles/private）是展示层语义，不是 RBAC。
- 已写入项目记忆 `project/local-app-positioning.md`，后续开发默认遵循。

**已按此定位接受的风险**：companion 无鉴权 + null-origin 放行（`file://` 必需），Firefox/旧 Safari 无 PNA 保护时公网页面理论上可读写本机服务——接受，不做架构级改造。

## D2. Bridge 不做主聊天代理

主聊天由浏览器直连各家 API；Bridge 只提供工具/看板/推送/AI 常驻会话等辅助能力。AI 常驻会话是独立于主聊天的一套。REST 接口无 token 鉴权是设计如此；开 `lan` 时建议配 token + 防火墙/Tailscale。

## D3. 酷狗点歌走"打开客户端/网页"，不改回内嵌流式

- 酷狗直连播放接口（`m.kugou.com/getSongInfo`、`wwwapi/play/getdata` 等）在开发环境实测一律返回"需要付费"——即使免费歌、即使带会员 Cookie。这是酷狗服务端限制，暂时无解（Cookie 是登录接口返回串，即使有效也被限制）。
- 因此页面点歌按钮走 `GET /api/music/open` 打开酷狗客户端/App（深链唤起，网页兜底）；`fallbackNetease` 提供网易云外链兜底。
- **不要试图改回内嵌流式播放**。若想恢复内嵌：需要更可靠的酷狗接口或用户从已登录浏览器复制真正的请求 Cookie（当前无解）。

## D4. 服务拆分约定：composition root 拥有状态，模块拥有逻辑

Bridge 与 Active 的拆分采用同一套约定：

- 工厂只接受显式依赖（如 `writeJson(file, obj)` 由根文件提供），避免 CommonJS 多文件循环依赖；根文件仍是 composition root。
- **可变业务状态保留在 composition root**——根文件对 whispers/healthData/geoLatest/letters/sessions/resident/contextStats/pushes 有多处重新赋值（删除心语、写入定位、删除信件等），若把状态搬进工厂闭包会引入别名漂移（保存时写回旧引用）。
- 路由内会被重新赋值的状态通过 getter/setter 注入（`getWhispers: () => whispers, setWhispers: v => { whispers = v; }`）保持与根文件绑定一致；仅原地变更的状态按引用注入。测试钩子 `resetStateForTest` 重新赋值 state，所以工厂一律用 `getState: () => state` 注入（active/persistence 首版把 state 放进闭包被测试当场抓出）。

## D5. 前端零构建步骤

原生经典脚本按原顺序加载；所有拆分（assets/js 子目录、game/ 六文件、core.css 12 段）都是**机械迁移**——保持原 IIFE 语句顺序、原 CSS 区段顺序与字节级内容（core.css 拆分后拼接与提交 `800411d` 原文件精确相等），不重新排序、不修改规则。直接打开 HTML 的启动方式不变。

## D6. window.IB 命名空间双挂载过渡策略

- 全部脚本已注册到 `window.IB`，但迁移期**双挂载**（window 与 IB 同时保留）：函数/const 直接挂 window；会被重新赋值的 var/let 用 `Object.defineProperty` getter/setter 实时转发；HTML 内联 onclick 调用的函数必须保留 window 挂载。
- 迁移方法论（后续新拆分直接套用）：扫描列 0 声明 → 按 kind 分类 → 函数/const 平挂、var/let 用 defineProperty 转发 IIFE 局部绑定 → `NS.expose` 全量注册；多声明行逐一人工核对补齐；迁移前检查 NS 标识符冲突；批量迁移前先确认文件是否已有 IIFE 包裹。
- 收紧方式（可选的未来工作）：逐步删除 window 挂载，每删一个跑全套浏览器回归。

## D7. 数据模型向后兼容优先，不轻易升 DB_VER

- Moments 作者身份扩展（user|role 双作者）、repostOf/repostText/replyTo 等均为**读取侧兼容层 + 可选字段增量**：无 authorType 的历史记录按 role 解释；不迁移数据、不升 DB_VER、不破坏旧数据；导出/导入结构不变（version 8 含 moments，importAll 按 keyPath id 回灌天然去重）。
- companion state 同理：moments/replyChains 加入时为 additive 字段，version 保持 3。

## D8. Social Net 不重写 moments.js

产品方向从"AI 朋友圈"调整为"AI 社交网络"时，决策是：既有服务函数（生成/评论/点赞/调度/companion 同步/聊天注入）原样复用，新域只做数据字段增量 + 视图层薄 API（social-network.js 视图层 IIFE）。`loadMomentsPage` 包装器只在 page-moments 处于活动页时接管渲染——直调/后台调用时旧渲染器照常工作；全部旧 DOM 契约 id 保留。

## D9. 后台独占调度语义 + 能力预检契约

- **独占语义**：companion 在线且能力支持 → 后台独占执行（浏览器 tick 不本地生成，只做节流快照同步）；companion 离线/旧版 → 浏览器本地执行。与 plans 的 background_enabled 独占语义一致，无双执行器双发。（主动消息 plans 是例外：双执行器防重复靠四层机制，见 ARCHITECTURE §5。）
- **能力预检而非试错**：前端同步前先 GET `/health` 做能力预检——响应无 `moments`（后加 `reply_chains`）字段即判定旧版 → 零 PUT 直接回退本地调度；循环内单角色 PUT 404/400 立即 break 本轮剩余角色。5 分钟窗口自动重探，用户重启新版 companion 后自动恢复，无需手动操作。（此前靠"发 PUT 撞 404"发现版本不匹配，每轮 N 连发且永不停止——已废弃的做法。）
- 关注（follows）是纯本地 localStorage 标记，不进导出；亲和度/可见性/冷却等 AI 行为机制不受影响。

## D10. 双端共享核心用 UMD 单文件

前后台都必须遵守同一套 Prompt 文本、解析/校验、候选选择、常量、亲和度/哈希——抽出 `reply-chain-core.js`、`social-observe.js`（浏览器 `<script>` 与 Node require 加载同一文件），前后台规则零分叉。禁止在两侧各写一份镜像逻辑。

## D11. 回复链"一次一步" + 执行前释放槽位

- `_momentsMaybeReplyChain` 是唯一入口；pending 状态保证同一时刻只有一个计划；执行前先释放槽位（status→idle），让新评论落库时能立即安排下一步——这是链条能延续而不死锁的关键。
- 45min 评论冷却是刻意设计：同一角色在快速链中只发言一次 → "多角色轮流接话"、不刷屏。若未来想允许同角色更频繁回嘴，放宽 `_momentsReplyRoomOk` 即可，不动其它护栏。

## D12. 输出解析失败优先修 token 预算，不删 jsonMode

Moments "output unparseable" 根因是推理型模型把 maxTokens=900 耗在 reasoning 上（content 为空），短正文 ≠ 小预算。修复：`MOMENT_GEN_MAX_TOKENS=2000` + 自适应重试（首次诊断 stage==='empty-output' → 重试预算加倍上限 8000）。schema 提醒文字解决不了 token 耗尽，提额才能。**不删 jsonMode、不动 schema 校验、不改 callApiChat/其他链路。**

## D13. 观测层纯旁路；关系系统禁止提前实现

- 行为观测层零行为变更：cooldown/affinity/reply-chain/companion 调度/Prompt/DB_VER 全部不动；接入点全部一行式旁路、失败静默；零新增模型调用。
- **校准等待中（禁止提前实现关系状态层）**：relationship score 初值 / 正负增量 / 时间衰减 / 事件记忆阈值 / prompt 注入数量 / 高亲和短冷却阈值——全部待 1–2 周真实分布数据回填后再定。

## D14. 已接受的债务与"审计确认已达足够、不再改"项

- 双执行器极小竞态：companion 误判离线 + DEL/PUT 双网络失败的理论窗口下可能双发（消息 ID 秒级幂等为最后兜底）——设计权衡，不阻塞。
- Feed 分页是渲染层分页（30 条/页），IndexedDB 全量读取改为有界游标后，扫描上限 360 之外的旧动态仍可导出但 UI 不再展示——个人应用可接受。
- 图片存储规模（~数 MB/月）经复审已达足够；Context/Token 各注入窗口均有界，不随朋友圈增长膨胀；未引入向量库。
- 每次 PUT /moments 携带完整快照，60s 节流不变；companion state.events 未 ack 会累积（ack 后即删，属 tasks/plans 共享行为）；私密动态内容进入 owner 角色 companion 快照属 owner-read 语义（本地服务边界内）。
- 后台 companion 只产纯文字动态（图片生成依赖浏览器 imageGen 链路）——增强非硬依赖，Node 侧镜像 imageGen 属候选工作。
- UI 小遗留：设置卡「免打扰结束」单独占左列、「主动规划方式」select 半列孤行（分组对称性取舍）；深色主题三级文字观感需真机核对。

## D15. 曾考虑但放弃/否决的方案

| 方案 | 结论 | 原因 |
|---|---|---|
| 恢复酷狗内嵌流式播放 | 放弃 | 服务端限制，Cookie 无效（见 D3） |
| RBAC/token 鉴权/用户隔离 | 否决 | 违背个人本地应用定位（D1） |
| companion 鉴权 + null-origin 收紧的架构级改造 | 否决 | 同上，PNA 风险按定位接受 |
| 引入向量库做记忆/动态检索 | 否决 | 现有 bigram Dice 相似度 + 有界窗口足够 |
| AI 评论触发 AI 评论（无限互评） | 否决 | "评论不再触发评论"，防刷屏；连续对话交给回复链（有轮数/频控上限） |
| 重写 moments.js 实现 Social Net | 否决 | 见 D8 |
| 用 schema 提醒文字解决空输出 | 否决 | 见 D12 |

## D16. 批量改写/提取脚本的失败原子性流程（固化）

任何提取/批量改写必须：(1) 先 mkdir 目标目录；(2) 先写新模块文件、最后再改父文件；(3) 父文件改写前留存完整备份或 Git blob；(4) 任何批量改写前确认 git 或外部介质有可回退副本。（来源：memory.js 提取 ENOENT 数据丢失事故，详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) T31。）

## D17. 大文件拆分前先建冒烟测试安全网

既定流程：拆分前先写 CDP 冒烟套件锁定行为（chat/workspace/memory/active-diary/game/socialnet 均如此），每步提取后全量回归绿再进行下一步。结构测试同时固化子模块 IIFE 首尾标记与独立语法断言（切片误删包裹会立即给出明确失败原因）。

## D18. Git 策略：测试绿才提交；私有仓库发布

- 2026-08-04 用户曾要求"不要提交、不要碰 GitHub"；2026-08-14 起建立本地安全基线：全量测试绿后才做本地提交（`800411d` `refactor: modularize local services and frontend domains`，将 assets/、active/、bridge/、游戏子模块和测试入口纳入版本控制）；`.dsh-recovery/` 加入 .gitignore。
- **2026-08-26 用户决定发布**：创建 GitHub **私有仓库**并推送，旧的"不碰远程"约束解除。
- 继续遵守：全量测试绿才提交；仓库保持 private（含个人应用内容）；敏感配置（AI API Key、酷狗 Cookie）只存在于本机 `%LOCALAPPDATA%`，永不入库——发布前已完成密钥扫描（kugouCookie 在库内均为占位符/空默认值/脱敏输出）。
