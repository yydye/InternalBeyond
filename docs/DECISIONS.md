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

> ⚠️ **2026-09-15 补注（不修改上文历史结论）**：本条针对的是**朋友圈 / 回复链的哈希亲和度**校准路径，
> 该等待**依然有效**。**角色私信域**后来实现了有向关系状态层（`trust` / `familiarity` / `affinity`，
> 见 `assets/js/role-dm.js` 与 [ROLE_DM.md](ROLE_DM.md)）——它有自己的初值（0.5 / 0.2 / 0.5）、
> 增量上限（`RELATION_DELTA_CAP = 0.03`）与 prompt 注入点，**不受本条约束**，
> 但也没有覆盖本条的校准诉求。后续读者**不得**把本条读成"角色私信关系层现在仍被禁止"；
> 反过来，也**不得**把私信关系层的存在当作"哈希亲和度可以开始做状态化"的依据。

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
- 继续遵守：全量测试绿才提交；敏感配置（AI API Key、酷狗 Cookie）只存在于本机 `%LOCALAPPDATA%`，永不入库——发布前已完成密钥扫描（kugouCookie 在库内均为占位符/空默认值/脱敏输出）。
- **2026-09-10 事实更正：仓库当前是 public，不是 private。** U1 实现期实测 `GET api.github.com/repos/yydye/InternalBeyond` 返回 `"private": false`（`visibility: public`，默认分支 `master`）。README 面向普通用户提供 Releases 下载链接，也只有公开仓库才成立。因此上面那条"仓库保持 private"**已失效**，改按公开仓库处理：更新功能依赖的 `releases/latest/download/...` 匿名读取正是建立在公开只读之上。**入库内容仍需按公开可见来审查**（历史密钥扫描结论不变，但仍需继续遵守）。

## U-D1–U-D5. Zero-Touch Update 冻结决策（U 系列）

> 2026-09-10 用户批准 Zero-Touch Update **U1–U4** 并冻结以下架构决策。U0 为只读审计（已完成，无改动）。
> 实现必须逐阶段（U1→U2→U3→U4）独立测试、独立提交；**偏离以下任一条必须先停下报告，不得就地"顺手改掉"。**
> 发布侧契约细节见 [RELEASE.md](RELEASE.md)。

### U-D1 · Manifest 载体与发布顺序

- Stable 更新契约采用 **GitHub Release asset** `update-stable.json`，客户端稳定读取
  `https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json`。
- 清单内 installer URL 必须是**完整、版本固定**的 URL；**禁止客户端自行拼 tag / asset 名**。
  唯一构造点是 `runtime/update-manifest.js` 的 `installerUrl()`（构建期使用），客户端只
  `validate()` + `parseInstallerUrl()`。
- 发布顺序固定：`...exe` → `SHA256SUMS.txt` → `update-stable.json`（**LAST**）。
  上传清单 = 该版本正式进入 Stable 通道。

### U-D1 Revised · 传输回退（2026-09-10 用户正式修订，**不覆盖**上面原决策）

> 修订原因（实测事实，不是推测）：U1 期在本机（中国大陆网络）实测 `github.com` /
> `raw.githubusercontent.com` / `codeload.github.com` **连接超时（10 s）**，而
> `api.github.com` ✅、`objects.githubusercontent.com` ✅、`release-assets.githubusercontent.com` ✅。
> 若严格只走 `releases/latest/download/...`，则在这类网络下更新检查永远失败——功能等于不存在。
> 上面 U-D1 的**规范地址与发布顺序不变**；本条只追加**传输回退**，并把回退的边界钉死。
>
> **U2 期更正（诚实记录，规则不变）**：U2 实现期在**同一台机器**重新实测，`github.com`
> 已可达（302，1.6 s），`raw.githubusercontent.com` / `codeload.github.com` 也恢复 200。
> 即 U1 观测到的**不是网络的稳定属性，而是间歇性阻断**。这不削弱本修订，反而加强它：
> 「有时通、有时不通」的入口正是必须有后备路径的情形；同时因为**常规路径仍然更快**
> （primary 1.6 s 内直接给出结果，且零 API 限额），primary 的地位不变。实测细节见
> [RELEASE.md](RELEASE.md) §8。

1. **Primary transport 不变**：`https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json`。
   常规路径零 API 限额。
2. **只有 primary 发生 transport / network-level failure 时才允许 fallback**，即**根本没有拿到
   HTTP response**：DNS 失败 · 连接超时 · 连接被重置 · 不可达（host/net unreachable）·
   跳转 hop 的传输层失败（超时/DNS/重置）· 其他明确无法取得 HTTP response 的网络错误。
3. **Fallback 一律走 GitHub Releases API**：`GET https://api.github.com/repos/yydye/InternalBeyond/releases/latest`，
   且只接受：`draft === false`、`prerelease === false`、asset 名**精确等于** `update-stable.json`；
   再经 asset API/CDN 端点下载该 manifest。
4. **以下情况禁止 fallback（hard validation failure）**，必须 fail-open 为「本次无更新信息」，
   **不得换路径绕过**：primary 已返回 HTTP response 但 manifest schema 非法 · `sha256` 字段非法 ·
   installer URL / asset identity 不一致 · version / productVersion 不一致 · manifest 安全校验失败 ·
   **跳转目标不在传输层白名单内（安全拒绝）** · 拿到任何 HTTP 错误状态码（含 404 / 403 / 429）。
   判定原则一句话：**没能完整取到一份 HTTP response 实体 = 允许回退；已经完整取到实体 = 其后
   任何问题都是 hard failure，且不得再换路径。**（响应头已到但实体读失败/被 RST 属「没取到实体」，
   即传输层失败——这正是上面第 2 条「连接被重置」的适用情形。）
   实现上这条规则压缩成一个可审计的等式：
   `fallbackAllowed(result) === (result.outcome === 'network')`
   ——`outcome` 只有 `response` / `network` / `protocol` 三种，回退只在 `network` 成立。
   实测（U2）：对真实 404 的 primary 响应**没有**触发回退（见 RELEASE.md §8）。
5. **API fallback 不是第二真源**：primary 与 API 最终取到的都是**同一个 Release asset**
   （`update-stable.json`）。API 只提供一条到达同一字节的替代路径，schema/校验/比较逻辑完全共用。
6. U2 其余约束不变：Node 侧唯一 manifest validator、Node 侧唯一 semver compare、24h cache、
   手动检查绕过 cache、**检查失败绝不进入 launcher 启动关键路径**、GitHub API 失败/限流也只视为
   「本次无更新信息」。
7. **不因回退引入 GitHub token、登录或任何额外配置**（匿名只读；`/repos/.../releases/latest`
   匿名限额 60 次/小时/IP，仅在 primary 网络失败时消耗）。
8. U1 的 `installer.url` / `version` / `hash` / `size` / `productVersion` 一致性约束**全部保留**；
   回退路径下这四条校验一字不改。

### U-D2 · UI 落点

Update UI 放入现有 **Diagnostics** 页，**不新建 Settings / Update 页面**。展示当前版本、更新通道
（Stable）、自动检查更新开关、[检查更新]；有更新时显示版本 + 更新说明 + [稍后] / [下载并安装]。

### U-D3 · 安装参数

自动更新固定使用 `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /IBRELAUNCH=1`。
用户在 IB 内点击一次"下载并安装"**即视为安装确认**，不再显示第二套 Inno Setup UI。

### U-D4 · 检查运行时（单一真源）

更新检查、manifest schema 校验、semver compare、缓存 **全部由 Node 侧完成**，是唯一真源。
Browser 只负责 UI；**禁止 browser 自己实现第二份 semver / manifest validator**。

### U-D5 · 重启由安装器完成

成功安装后的 relaunch 由 **Inno Setup** 完成。**禁止 bundled Node updater helper 活过安装阶段**：
helper 只做「下载 → hash/version 校验 → spawn installer detached → **EXIT**」（必须在安装器开始
替换 `node.exe` 之前退出），随后由安装器 `StopInternalBeyond → wait unlock → replace →
validate runtime → /IBRELAUNCH=1 → wscript 启动 InternalBeyond.vbs`。
**保留现有普通交互安装 `[Run] postinstall skipifsilent` 行为，不得为了 updater 改坏它。**

### U-D6 · Installer Payload Transport Fallback（2026-09-10 用户冻结）

U-D1 Revised 只覆盖了「**检查**清单」的传输回退。U3 要下载 50 MB 级**载荷**，而载荷走的
`github.com` 在同样一些网络上是间歇不可达的，因此把同一条规则扩展成载荷版本，作为**独立新增
决策**（不改写 U-D1 / U-D1 Revised 任何一字）：

1. **Primary download**：使用经过 U1/U2 `validate()` 的 `manifest.installer.url`（版本钉死的
   release asset）。客户端不得自行拼接 URL；实现上还要用 `parseInstallerUrl()` **再解析一次**
   自己的输入，主机 / tag / 资产名任一不符即拒绝，连连接都不开。
2. **只有 primary 发生 network / transport-level failure，且完全没有获得有效 HTTP response
   实体时**，才允许 GitHub API asset fallback。判定等式与 U-D1 Revised 完全同一个：
   `fallbackAllowed(result) === (result.outcome === 'network')`。
   响应头已到但实体读取失败 / 被 RST（含中途断流）= 没取到实体 = 传输层失败，允许回退。
3. **fallback**：`GET GitHub release metadata`，只接受 `draft === false`、`prerelease === false`、
   **release tag 与 `manifest.version` 一致**、**资产名精确等于
   `InternalBeyond-Setup-<manifest.version>.exe`**；再经 asset API/CDN 下载**同一资产**。
   fallback 只是**传输替代**，不是第二发布真源——最终用来放行的仍然是 manifest 里那一个
   sha256，且必须由本地重新计算确认。
4. **以下情况禁止 fallback（hard failure → 本次安装失败，不得换路径、不得重试）**：
   HTTP 4xx/5xx（含 404 / 403 / 429）· wrong asset · wrong release/tag · invalid Content-Length
   （缺失也算）· size mismatch（声明长度或实际字节与 `sizeBytes` 不符）· sha256 mismatch ·
   PE ProductVersion/FileVersion mismatch · 任意安全校验失败（含跳转出传输白名单）。
   已经完整取到实体之后的一切问题都是终局。
5. **`asset.digest`**：若 API 声明了 digest，**必须**等于 `sha256:<manifest.installer.sha256>`，
   不一致 = hard failure；digest 缺失**不单独构成失败**；digest 存在但无法解析（非 `sha256:` 或
   非 64 位十六进制）同样按 hard failure 处理——「无法解读的完整性声明」不得当作「没有声明」。
   最终**仍必须对本地下载文件重新计算 SHA-256**，API 的声明只是额外一道交叉校验。
6. **浏览器不得向 `/__update/start` 提交 URL / hash / path**。服务端只能使用**自己已验证的
   cached/pending manifest**（`%LOCALAPPDATA%\InternalBeyond\update-check.json`，读回时重新
   `validate()`）。browser 最多提交**版本确认**（或 opaque update id，当前未使用）；请求体出现
   任何其它字段一律 **400 拒绝并点名该字段**，服务端**不接受**任何定位或描述载荷的输入。
7. **下载 helper 继续满足**：HTTPS only · redirect 每一跳 host allowlist · 下载到
   `%LOCALAPPDATA%\InternalBeyond\updates`（**绝不进 `{app}`**，越界配置直接拒绝）·
   `.part` → 校验完成后 **atomic rename** · hash/尺寸/PE 不符**删除文件** · `shell:false` ·
   detached spawn installer · helper 随即 EXIT · **不实现 stop**，继续由 installer 调
   `ib-stop.js`。
8. **优先复用 U2 已存在的 transport / error classification / host validation**。U3 实际做法是
   **最小抽取**：把 U2 里本来就在一个函数里的 hop 遍历 + 主机白名单 + 网络错误分类移入
   `runtime/update-transport.js`，把「正文处理」参数化为 sink（文本 sink = U2 原语义，文件
   sink = U3 流式落盘 + 边下边算 hash）。**没有第二份传输实现**，也没有顺手重构 U2 的行为
   （U2 全部原有测试一字不改地继续通过）。

### U-D7 · Update Completion Truth（2026-09-10 用户冻结 · U4 已实现并测试通过）

> 登记的是**已经写进代码、已经有测试守着的事实**，不是新的设计要求。
> 证据：`tests/test_update_card.js`「成功提示：只有版本真的变了才算，且只显示一次」
> 与「一次性判定的纯逻辑边界」。实现：`assets/js/update-card.js`。

「更新成功」只有一个判据：**本机实际运行的产品版本 == 目标版本**。
「安装器被启动过」不是成功，「状态文件写到 `launched`」也不是成功——两者只证明接力棒交出去了。
这条把「点了按钮」和「真的装上了」彻底分开，避免产品在最需要诚实的地方报喜不报忧。

1. **判据是版本相等，不是版本变化**：`compare(current, target) === 0`（`runtime/product-version.js`，
   U-D4 的唯一 semver 比较）才算完成。仅仅「和旧版本不一样」不构成完成。
2. **待判定标记 `ibUpdatePendingV1`**（浏览器 localStorage，带 `schema` 字段）在用户确认开始安装时写入，
   **读取一次即删除**（consume-once）。因此「已更新到 InternalBeyond x.y.z」**最多显示一次**，
   第二次启动不再出现——由产品自身保证，不依赖 UI 记忆或用户清缓存。
3. **成功判定不依赖网络**：判定只需要两样本地事实——标记 + 当前版本文件。
   即使此刻完全联不上网（`/__update-check` 不通），只要版本真的等于目标版本，就必须如实显示成功。
4. **版本读不到时不下结论**：既**不报成功**也**不报失败**，标记静默消费（诚实未知 > 编一个结论）。
   `VERSION` 不可读时 `product-version.js` 返回 fallback，调用方按「不知道」处理。
5. **判定只做一次**（`judged` 一次性闸门）。旧版本重开后判为
   「更新未完成，当前仍为 x.y.z」+ [重试]，同样消费标记（只提醒一次）。
6. **U4 只提交 `{ version }`**：完成判定完全在前端完成，**不新增后端端点、不改 U3 状态机**。
   U-D6 第 6 条（浏览器不得提交 URL / hash / path）在完成判定这条路上同样成立。

### U-D8 · Installation Disconnect Semantics（2026-09-10 用户冻结 · U4 已实现并测试通过）

> 登记的是**已经写进代码、已经有测试守着的事实**，不是新的设计要求。
> 证据：`tests/test_update_card.js`「installing：固定说明、无百分比、断开不误报」、
> 「失败分类」、「一次性判定的纯逻辑边界」。实现：`assets/js/update-card.js`。

安装阶段的「**读不到状态**」和「**装失败**」是两件不同的事，UI 必须分开表达。

1. **进入 `launching` 即锁住**：阶段固定为 installing，**百分比与进度条一律撤掉**
   （数字会停在 100% 然后开始说谎），动作按钮全部隐藏，只保留**固定安装说明**
   +「如果没有自动重新打开就手动打开」的兜底提示。`launched` 是终局：停止轮询。
2. **断开 ≠ 失败**：此后轮询**任何**读不到状态的情形——连接被拒、服务被安装器停掉、超时、404——
   都**不得**改判为失败，**不得**回退成「已是最新」，**不得**出现 [重试]。连续读不到也不改判
   （`installing` 一旦置位即锁定）。理由：安装器**必须**先停掉本实例才能替换被占用的文件，
   「服务消失」是这个功能的**预期中间状态**；把它显示成失败就是谎报。
3. **唯一能打断第 2 条的信号，是后端明确写下 `state = 'failed'`**（＝安装器根本没起来）。
   这是**事实**，不是「读不到」，此时**必须如实汇报**：本次尝试内 → 稳定分类文案 + [重试]；
   重启后由标记判定 → 「更新未完成，当前仍为 x.y.z」+ [重试]。**不报就是骗人。**
4. **失败记录必须先证明属于这一次尝试**：状态文件跨启动留存，上一次的 `failed` 会一直躺在里面，
   直到新 helper 写下第一行。判定条件 = 版本对得上 **且** 状态时间不早于本次尝试
   （2 s 容差，`statusIsOurs`），否则不采纳——否则用户点 [重试] 会读到**上一次**的失败并秒报失败。
5. **启动判定是终局**（`applyStatus` 见到 `updated` / `incomplete` 直接返回）：挡住一个真实竞态——
   自动检查先判出「已更新」，紧接着早先那次启动状态读取才回来（状态文件仍写着 `launched`）；
   没有这道闸门，卡片会在成功提示之后又跳回「正在安装」。
6. **用户明确要求再查一次时终局让位**：`?force=1`（手动 [检查更新] / [重试]）清掉旧结论，
   否则终局闸门会挡掉后续全部检查结果，按钮变成空按钮。标记早已消费，结论不会因此重复出现。
7. **检查超时必须长于服务端最坏情况**：UI `CHECK_TIMEOUT_MS = 30000` ≥ 服务端
   primary + fallback 三段各 8 s 往返（有测试守着这个不等式）。UI 先放弃 =
   把「还在查」显示成「查不了」，正是 U2 刻意避免的假失败。

## D19. 统一思考深度（reasoningEffort）走 capability-driven，不做 provider 硬编码（P21）

### 决策

1. **canonical 字段只有一个**：Middle Brain 配置里的 `reasoningEffort ∈ {auto, low, medium, high, max}`，
   默认 **auto**。UI 只写这一个字段，消费者只读这一个字段（`IB.middleBrain.middleBrainReasoningEffort()`）。
2. **auto 的语义 = 不发送任何 reasoning 参数**（保持 provider 原生自动行为）。
   DeepSeek 的实测证据（普通聊天 `reasoning_tokens=125` / 日记 `1082`，IB 当时**没有**发送任何
   reasoning 参数）就是这条语义的基线：auto 下请求体必须与上线前**逐字节一致**。
3. **能力事实只能存在于 `assets/js/provider-directory.js`（P21 的 `REASONING_CAPABILITIES` /
   `REASONING_MODEL_POLICIES`）**；翻译只能发生在 provider adapter / request builder 边界
   （`ib-model-core.js` 的 `applyReasoningEffort` → `buildRequestBody` / `AstraAdapter.buildResponsesRequest`）。
   `communication.js`、UI、Middle Brain 各层**禁止**出现任何一家 provider 的字段名判断（有结构测试守着）。
4. **只发官方明确支持的参数，且必须 model 级成立**；未取证的 provider（deepseek / gemini / glm / qwen /
   minimax / mimo / custom / 未知）与未取证的 model 一律 **abstain（一个字段都不发）**，
   并记录 `reasoningFallbackReason`。典型例子：OpenAI 的 `reasoning_effort` 只对推理型 model 成立，
   非推理模型（如目录默认的 `gpt-4o-mini`）收到会 400 —— 所以它按 model 逐条登记，
   绝不因为"provider 是 openai"就照发。
   取证完成后把条目从 `REASONING_PENDING` 搬进能力表即可 —— 这是纯数据改动，不需要碰 request builder。
5. **不支持某档位 → 就近降级（tie 取更低档，绝不向上越档）**并记录 `tier_downgraded`；
   Anthropic 这种没有档位枚举、只有 thinking 预算的 provider 用预算表表达，
   且必须满足官方约束 `1024 ≤ budget_tokens < max_tokens`（不满足就 abstain，绝不拼非法请求）。
6. **Speed（service_tier）与 Reasoning Effort 严格分离**：两个字段、两个出口，互不写入。
7. **旧配置一次性迁移为 auto**：只有显式带 `reasoningEffortV2` 标记的配置才承认其档位；
   历史值（low/medium/high/xhigh/max）一律按 auto 解析，用户重新选择后才落盘。
   理由：上线前该字段**只影响 Middle Brain 自己的调用**，上线后会作用于角色聊天/日记等消费者 ——
   不能让老用户"没做任何操作，聊天的请求体就变了"。历史 `xhigh` 合并进 `high`。
8. **观测只读**：`IBModelCore.reasoningTrace()` 记录
   `requestedReasoningEffort / effectiveReasoningEffort / reasoningWireParam / reasoningFallbackReason`
   + `reasoningTokens`（来自 provider 真实回传的 usage）。白名单构造，不含 prompt / 请求体 / apiKey；
   不改变 token 记账口径（i/cr/cw/o 不动）。

### 理由

- 不同 provider 的"思考深度"根本不是同一个东西（档位枚举 / 预算 token / 开关），
  把它塞进 Middle Brain 或 UI 的任何一处分支都会立刻退化成"每加一家 provider 就改三处"。
- 未取证就发电商参数 = 在生产聊天路径上做实验：一个字段放错，用户看到的是 400 直接把对话打断。
  「宁可不发」是这个功能唯一安全的默认。

### 已接受 / 未做

- **Gemini / 国产 provider 的档位当前不生效**（abstain）。这是刻意的保守取值，
  不是遗漏：取证依据与"还差什么"逐条登记在 `REASONING_PENDING`。
  （DeepSeek 已按 D19.1 校准。）
- 未接入 `temperature` 之外的其它采样参数；不改 Moments/Diary 的 maxTokens 预算
  （提高档位会让 reasoning 更吃 token，与 D12 的教训相关，登记为后续项）。
- Node ModelPort 已接受 canonical `reasoningEffort`（与浏览器同一份翻译），
  但 Node consumer 目前无人提供该值（Middle Brain 配置在浏览器 IndexedDB）。

### U 系列安全不变量（全阶段冻结）

HTTPS only · hash 不符**绝不执行** · installer 版本不符**绝不执行** · `shell:false` ·
不执行远端命令 · 不做自修改/热更新 JS · 不按端口盲杀（复用 `ib-stop.js`）·
更新失败不得阻塞启动（fail-open）· 用户数据（在 `{app}` 之外）不受影响 ·
**更新载荷绝不下载进 `{app}`** · 不得存在使用 bundled `node.exe` 的长命 helper。
未代码签名的事实必须留在文档中；**SHA-256 只能证明「字节与清单一致」，绝不能描述成
「验证发布者身份」。**

## D19.1 P21.1 · DeepSeek reasoning capability 校准（2026-09-11）

D19 的机制一行未动，只往数据表里补一条**已取证**的 model 能力：

1. **只登记一个 model id：`deepseek-flash`**（model 级 `REASONING_MODEL_POLICIES`）。
   `REASONING_CAPABILITIES.deepseek` **不存在** —— 能力绝不按 provider 宽泛开启；
   DeepSeek 的其它 id（`deepseek-v4-pro` / `deepseek-v4-flash` / `…-vision-exp` / `deepseek-reasoner`）
   继续 abstain，有测试逐条守着。
2. **wire 契约**：Chat Completions 面 `reasoning_effort ∈ {low, high, max}`。
   auto 不发送任何 reasoning / thinking 字段；**不主动发送 `thinking.type`**（保持 provider 原生 thinking 行为）。
   `wire: { chat: [...] }` 是有意为之：Responses 面未取证 → `format_unsupported`，而不是"忘了写"。
3. **canonical 映射**：low→`low`；medium→`high`（effective=high + `tier_downgraded`）；
   high→`high`；max→`max`。
4. **新增的是数据字段 `tierMap`，不是分支**：官方值域缺 medium 时，通用阶梯就近会出现
   low/high 同距的 tie，而"该落哪一档"只有 provider 自己知道。tierMap 把这个判断放回数据表，
   通用规则（tie 取更低档）与 request builder 一行未动；tierMap 取值若不在 `values` 内一律视为
   不支持 → abstain（防止表里写错值静默发出）。
   `applyReasoningEffort` / `reasoningWirePlan` 里**没有** `provider === 'deepseek'` 这类判断，
   `ib-model-core.js` 中甚至不出现 `deepseek` 这个名字（结构测试守着）。
5. **基线不动**：`auto` 下 deepseek-flash 的 chat / diary 请求体与 MB 关闭时**逐字节相等**
   （= P21 上线前的真实字节，CDP 断言 E1/E1b）；Speed(service_tier) 与 reasoningTokens
   观测口径均不变（E11 / E10）。旧配置迁移策略、UI 五档、canonical enum 一律未改。
6. **取证来源是用户确认的 wire 契约**（不是本仓库查到的官方文档原文）：若 DeepSeek 实际只接受
   其它取值或字段名，症状会是**聊天直接 400**；此时把 `deepseek-flash` 从
   `REASONING_MODEL_POLICIES` 移除（一行数据）即可回到 abstain，无需改任何代码。


## D20. M1-C · Android Thin Client（2026-09-11）

M1-A/M1-B 把 canonical chat 与设备身份放在 Home Node（桌面）之后，M1-C 交付了**第一个真
正的 Android IB**：`android/` 独立 Gradle 工程，产出可安装 APK，在同一 LAN 内完成配对 →
角色列表 → 读取同一份历史 → 发消息 → 实时流式回复 → 断线恢复。冻结以下决定：

1. **Android 是 thin client，不拥有 IB 世界。** Android 只拥有 UI / 设备凭据 / cache /
   draft / sync cursor；canonical chat、角色运行配置、provider 凭据、生成、revision、
   幂等、设备登记表继续全部属于 Home Node。**禁止**任何 provider 直连、第二套
   IBModelCore / Middle Brain / memory runtime、第二套 canonical chat DB。
   结构上保证：`data/api/HomeNodeClient.kt` 是全 App 唯一发 HTTP 的地方；APK 只申请
   `INTERNET` 一个权限。
2. **技术路线：Kotlin + Jetpack Compose + OkHttp + 平台 SQLite + Android Keystore。**
   不用 WebView/Capacitor（AI runtime 已在 Home Node，手机不需要浏览器世界，更不需要
   把 M1-A 刚从客户端移走的 IndexedDB chat 权威再搬回来）；不用 Room/KSP（6 张小表、
   手写 upsert 与 delete 语义，`SqlDatabase` seam 让真实 SQL 能在 JVM 测试里跑）；不用
   navigation-compose（4 个页面 + 一条明确的 back ladder，40 行纯 Kotlin 且可单测）；
   不用已废弃的 security-crypto。**运行时第三方依赖只有 OkHttp 一个**（理由：SSE 需要
   「连接有超时、读取无超时」+ 可跨线程取消阻塞读取，HttpURLConnection 无法在不改全局
   状态的前提下表达）。
3. **device token 只以密文存在。** Keystore（alias `ib.device.credential.v1`，
   不可导出）+ AES-256-GCM，密文进 SharedPreferences；`deviceId` / endpoint /
   fingerprint 明文保存是**有意的**（App 必须在能开 Keystore 之前就能显示
   「Connected to …」与「凭据在本机已不可读，请重新配对」）。解不开的密文**保留**并如实
   上报，绝不静默当作「从未配对」。
4. **协议行为按 M1-B 冻结执行**：客户端不自造 canonical message id（乐观消息是
   `SendAttempt` 记录 + overlay，不是 messages 表里的一行）；requestId 在发请求**之前**
   落盘，投递重试始终复用同一个；**terminal frame 终止该义务**——终态错误后的「重新发送」
   是新 requestId；`disconnect ≠ cancellation`（丢流 → RECOVERING，绝不 FAILED →
   `turns.get` → resume → `sync.changes`）；重复帧丢弃、缺口从 lastSequence 重连；
   `REPLAY_GAP` 语义是「从 canonical 状态补齐」。UI 只说
   「LAN connection · not encrypted」，在没有 TLS 之前绝不出现 secure/encrypted。
5. **cleartext 策略按构建变体分离**：debug（M1-C 交付物）在 network security config 里
   显式允许 trusted-LAN 明文；release 保持 `cleartextTrafficPermitted=false`，只放行
   loopback / 模拟器别名 / `.local`。**限制如实登记**：Android 的 domain-config 只接受
   主机名或 IP 字面量，**不接受地址段**，因此 release 包连任意 RFC1918 地址必须走 TLS 或
   主机名（属已推迟的传输层工作）。这不影响身份模型——身份是 device token，不是 IP。
7. **【已被 D21 修订，以下为当时的现场记录，历史保留不得覆盖】LAN 可达性：M1-C 未改动 Home Node 的 loopback 守卫，如实登记为唯一剩余 blocker。** 实测（真实服务以 `IB_HOME_NODE_HOST=0.0.0.0` 绑定、数据目录隔离、设备登记表已打开、日志有 `lan-bind-enabled`）：LAN 上 `/health`、`/mobile/v1/character/list`、`/mobile/v1/pairing/complete` **全部 403 `{"ok":false,"error":"loopback-only"}`**，只有 loopback 能配对成功。原因：`services/home-node/http.js:435` 的 `if (!isLoopback(req) && !deps.allowRemote)` 在路由**之前**执行（因此覆盖整个 mobile 命名空间），而 `services/home-node-service.js` **从不设置 `allowRemote`** —— 这是 M1-A 的既定保护，M1-B 加 LAN 绑定能力时没有放开它。开关一旦打开，链路已被证明可用：载荷会给出真实 LAN 地址（`lanReachable:true`，无需 override）、配对发凭据、token 生效、凭据不外泄。**本阶段刻意不去翻这个开关**：把 Home Node 暴露到 LAN 属于桌面侧的安**全姿态决定，不属于 Android 客户端阶段，且 M1-B 明确把 LAN 暴露定为 opt-in。App 侧只做了一件事——把 `loopback-only` 映射成明确文案（`LOOPBACK_ONLY` →「Home Node 只接受来自桌面的连接，LAN 访问尚未开启」），而不是让严格 v1 解析器把它报成「意外的响应」。
8. **验证方式**：`./gradlew test` 105 项全绿，其中 `HomeNodeIntegrationTest` 真实
   spawn `services/home-node-service.js` + 真实 SSE mock provider，用**与 APK 同一份**
   HomeNodeClient / SessionRepository / ConversationSession 走完
   pair → character.list → chat.history → chat.send → streaming → 断线 → resume →
   sync.changes → 同 requestId 重试 → presence → revoke。没有 emulator，因此 APK 只做到
   「编译 + 签名 + 校验包内 manifest/网络策略」，未在设备上启动过。

---

## D21. M1-C 修复 · Home Node LAN 门（allowRemote）（2026-09-11）

D20 第 7 条登记的「真机前唯一 blocker」在这里被修掉。修法刻意**不是**把 M1-A 的守卫
翻成 `true` —— 那等于把整个桌面面交给局域网。冻结以下决定：

1. **`allowRemote` 是一个被验证的谓词，不是一个开关。** 唯一定义：
   `显式非 loopback 绑定(HOST) && deviceAuthReady(registry)`。
   两条都必须为真，且后者是**运行时能力**而非配置事实。
2. **`deviceAuthReady()` 必须走一遍真实鉴权路径**（`services/home-node-service.js`）：
   拿一个格式合法但不可能存在的 token（`ibd1_probe-…`）问注册表，期望明确的
   `AUTH_INVALID`。`STORE_CLOSED`（没开）、抛异常（查询坏了）、`ok:true`（陌生 token
   被判有效）都判为**未就绪**。探针带 `touch:false`，不产生设备状态副作用。
   —— 这条规则保护的是整个聊天库 + 签发/撤销凭据的能力，值得一次真实探针。
3. **`http.js` 的 `deps.allowRemote` 接受函数，并且每次请求重新判定。** http 层是在
   `open()` **之前**构造的，把结果固化成布尔等于把一个尚未证实的前提写进安全决策。
   判定抛异常时 fail-closed。
4. **门开了之后，远端仍然碰不到桌面面。** 规则：非 loopback 来源的**非 `/mobile/v1/*`**
   路径必须有**已配置且匹配**的桌面 token；**未配置 token → 403 `remote-admin-disabled`**
   （不是 401：不存在任何能奏效的凭据）。为什么必须有这条：`authorized()` 在未配置
   token 时对一切放行（loopback 单用户模型），而**默认安装就是没有 token** —— 不加这条，
   打开 allowRemote 就等于让局域网里任何人匿名调用 `/pairing/session`（签发配对凭据）
   与 `/device/revoke`（撤销设备）。`/mobile/v1/*` 不受这条约束：那是设备面，凭据是
   device token，由网关自己判定；若它也被约束，手机将永远无法在 LAN 上配对。
5. **`/health` 从"匿名可达"收紧为"loopback 或已配置的桌面 token"。** 桌面
   local-services-runner / 诊断页在 loopback 上不带 token 打它，行为不变；但 LAN 上
   匿名可读到 `revision` / 消息条数，那不是我们愿意用便利换的东西。
6. **默认不变**：`IB_HOME_NODE_HOST` 不设时仍是 `127.0.0.1`，远端在 socket 层就连不上；
   设备鉴权打不开时，非 loopback 绑定**仍然拒绝启动**（M1-B 的硬门保留）。新增一层：
   注册表打开了但探针不通过时**不退出**，而是只服务 loopback 并把原因写进日志 ——
   一个坏掉的鉴权子系统不该让本机用户连不上自己的 Home Node，而"远端一律拒绝"
   本身就是安全的失败方向。
7. **启动日志必须可审计**：`lan-bind-enabled` 带 `allowRemote` 与 `deviceAuthProbe`
   两个字段，`listening` 带 `remoteClients: refused (loopback bind) |
   device-token-required | refused (<reason>)`。安全决策不允许只存在于代码里。
8. **证据（真实进程 + 真实 LAN 源地址）**：`tests/test_home_node_lan_gate.js`，41 项。
   关键点是所有"远端"请求都发往本机**非 loopback 地址**（于是源地址也非 loopback）——
   用 127.0.0.1 打请求永远走不到这条规则，测到的只是"门后面的东西没坏"。
   覆盖：LAN 上 `pairing/complete` → 200 并签发 device token；LAN 上 `character.list`
   用该 token → 200 且返回已发布角色；未认证 / 伪造 token / 伪造配对载荷仍被拒；
   撤销对 LAN 立即生效（403 `DEVICE_REVOKED`）；默认姿态下远端连不上；
   鉴权未就绪（真实故障 `devices_schema` 过新）时 0.0.0.0 实例对远端一律 403
   `loopback-only` 而 loopback 照常；未配置桌面 token 时 LAN 上 5 条桌面路径
   全部 403 `remote-admin-disabled`，同时手机仍能配对成功。


## D22. M1-C.1 · 移动端 UI 基础（Mobile UI Foundation）（2026-09-11）

**背景**：M1-C 真机首测发现 Android 端只是工程验证界面 —— Material 3 demo 外观、
全英文、配对首页直接摆一个 JSON 文本框和 F12 控制台命令。功能正确，但不是产品。
本阶段**只改 UI/UX**，Home Node 协议、Chat authority、pairing contract、
cache/sync/recovery 全部未动。

1. **配色不是新调色板，是桌面端暗色的横读**。`IbColors` 取 `assets/css/core.css`
   的 `--bg-deep`/`--bg-mid`、`rgba(155,180,218,α)` 玻璃族、`--accent`/
   `--accent-light`、四个 `--status-*`。只做两处偏离：页面底色比 `--bg-deep` 更深一档
   （玻璃需要有东西可以透），以及新增仅作为「光」存在的蓝紫环境渐变 —— 它永远不是
   某个字或某个控件的颜色。
2. **强制深色，禁用 Material You**。取色板跟着壁纸走，正是把产品配色变成
   「恰好是深色的 Material demo」的原因；IB 自己的配色就是桌面端那一套。
3. **两个字体族各有分工**：`FontFamily.Serif`（系统自带 Noto Serif CJK，不打包字体）
   是**角色的声音** —— 配对页的承诺、角色名、气泡里的内容；`FontFamily.Default` 是
   **应用的声音** —— 按钮、状态、设置、时间戳。零字节成本。
4. **文案规则结构化，并由测试强制**。`ui/IbStrings.kt` 直接持有的值一律面向用户，
   不得出现任何开发者词；`IbStrings.Dev` 是唯一允许出现 Home Node / payload / JSON /
   HTTP / F12 / IB_HOME_NODE_HOST 的地方，且只在折叠的「开发者信息」「开发帮助」里渲染。
   `IbCopyTest` 用反射遍历两半：用户侧出现一个泄漏词即失败；同时断言开发者侧**仍然**
   含这些词 —— 否则把词表删掉就能让这个守卫空过。错误文案同规则：
   `ErrorPresentation` 新增 `technical` 字段承接协议自己的说法，只在「详细信息」展开时显示。
5. **协议词从主界面彻底移出**。配对首页不再出现 Home Node、地址、JSON、F12；
   地址与对方身份移入「高级设置」，控制台命令移入「开发帮助」（这是它唯一被允许存在
   的地方，因为桌面端还没有配对按钮，删掉它会让 app 变得不可用而不只是更朴素）。
6. **状态行只说真话**。首页的状态点由真实 `ConnectionState` 驱动；空闲时不会出现
   永远的「正在寻找附近的电脑」—— 这一版没有 discovery，一个假装在搜索的动画就是假功能。
7. **角色卡不写「在线」**。移动端 DTO 没有 per-character presence，角色也不是设备；
   名册只显示它真知道的东西（已归档、视觉），可达性由顶部的连接徽标统一表达。
8. **数据/domain 层的唯一改动是用户可见文案**，逐条列明：`PairingPayload.kt` 的
   `PairingParse.Fail` 标题/说明与 `missingAddressExplanation`；`SessionRepository.kt`
   的「地址用不了」与两条凭据提示；`HomeNodeEndpoint.transportLabel`。字符串内容之外
   零逻辑改动，校验分支、顺序、判定条件全部未变。`HomeNodeClient` 一行未改（它在冻结
   名单上），代价是它的两条英文 `Local` 消息仍会在极窄路径下出现 —— 已记入已知限制。
9. **本阶段的验收证据包含一次真机（模拟器）运行**。`android-34` AOSP x86_64 镜像
   无窗口启动 → 安装 debug APK → 通过 LAN 与真实 Home Node 配对 → 四个页面全部由
   无障碍树定位真实点击驱动并截图。测试 109/109 绿，`assembleDebug` 通过。
10. **这次运行发现两个既有缺陷，均未在本阶段修**（见 `docs/ANDROID_THIN_CLIENT.md` §7.9/§7.10）：
    `mobile-dto.js` 的 `characterDto` 只读 `raw.archived`，而出站会对**已落库的 DTO**
    再投影一次，导致 `status` 在「发布 → 落库 → 出站再投影」这条链上丢失（`name` 与
    `capabilities` 都有两级回落，`status` 没有）；以及 `SessionRepository.verify()`
    在冷启动路径上**从未被调用**，与其自身注释所述的 boot 行为不符，表现为重启后
    「协议版本」为空。两者都不属于 UI 阶段，且第二个牵涉 data 层行为，故只记录不动手。

## D23. 身份与 provider 一律从 runtime spec / wire body 取证，**绝不**从模型的输出文字反推（2026-09-11）

**这条规则来自一次真实事故**（完整复盘见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) T42）。

移动端选「昔涟」发消息，模型回答「我是 Claude，由 Anthropic 开发的 AI 助手」。当时最自然的
解读是「Anthropic 的 key 泄漏了 / 请求打到了 Claude 上」——**完全错**。实测该角色 runtime spec：
`provider = glm`、`model = glm-5.3-flash`、`endpoint = open.bigmodel.cn`，**没有任何 Anthropic
端点或密钥参与**。真因是 `execution.js::buildPrompt()` 读了错误的字段层（顶层
`character.systemPrompt` 而非 `character.spec.systemPrompt`），770 字人格被丢成空串，于是
**GLM 在 0 字 system prompt 下退回了自己的预训练默认身份**——而它的默认身份恰好宣称自己是 Claude。

固化为三条：

1. **不从输出文字反推身份 / provider / 模型。** 模型的自我认知是**上下文缺失的症状**，不是
   provider 的证据。反推不仅可能错，还可能把排查引向**完全相反**的方向（去查一个根本不存在的
   密钥泄漏，而真正的问题是丢掉的一行字段搬运）。要判定 provider，读 runtime spec、读 wire body、
   读 endpoint —— 读得到的东西。
2. **「省了一行」和「泄漏了密钥」可以长得一模一样。** 一个空 system 产生的输出，与「打到了别家
   API」产生的输出，在肉眼与另一个模型看来都可能无法区分（这个案例里，把原始输出拿给 Claude
   本尊看，本尊也认为「背后就是 Claude API」）。所以事故归因必须先排除「我们自己丢了什么」，
   再考虑「外部变了什么」。
3. **测试只证明了一个方向的边界，就等于没证明边界。** 该 bug 之前，109 个测试全绿：
   `spec.systemPrompt` 不会到 Android（安全方向，做得很好）、`buildPrompt` 会用
   `character.systemPrompt`（但输入是**测试自己合成**的）。**「秘密不漏出去」被测穿了，
   「秘密送得进去」没人测。** 由此确立：涉及信任边界的组件，**两侧都要有断言**，
   且断言必须跑在**调用方实际给的输入形状**上，而不是函数偏好的形状上。

**边界外的字段（`relationship` / `nickname` / Memory / Middle Brain / `reasoningEffort` /
`thinkingEnabled`）不在本次修复范围**，属于 Runtime Parity 的后续设计，不混进 root-cause fix。
（另：`speech_style` **不是**一个被漏掉的字段 —— 全仓库它只作为 `middle-brain-integrity.js`
的**完整性维度名**出现；桌面的说话风格来自 `systemPrompt` 正文 + `IB.brevity.apply()`。
不要为它造字段。）

## D24. 角色私信每轮"一个字都没说成"：先分辨**预算**与**故障**，再谈重试（2026-09-15）

**同一个坑的第二次**（第一次见 D12）：
`role-dm.js` 的每一轮发言曾经固定 `maxTokens: ctx.maxTokens || 700`。真实模型探针
（真实 key、真实 provider、临时浏览器 profile，注入的配置只进页面内存）测到的
**provider 原始回包**是：

```
finish_reason = "length"   content 长度 = 0   reasoning_content = 1098 字符   completion_tokens = 701
```

也就是 700 个输出 token **全部**花在思考上，正文一个字都没开始。而旧代码把"正文为空"
归成 `provider-failed`，用户看到的是「有一方没能回应（模型请求失败）」——于是去查一个
**根本没坏**的 API key（同一对角色、同一个模型 id、同一把 key，从 Node 侧直连 provider
是 HTTP 200）。**短正文 ≠ 小预算。**

- **每轮预算 700 → `TURN_MAX_TOKENS = 2048`。** `max_tokens` 是**上限**而不是计费：
  给宽不会让一次发言更贵，只会让本来能说完的话不被砍断。角色私信的成本护栏不在这里，
  在**轮数 / 日额 / 冷却**（`roleTurnTimes`、`dailyLimit`、`pairCooldown`）——这三条一条都没动。
- **发言改为 `wantMeta: true`**，因此能拿到执行器的 `truncated`。没有它就**无法区分**
  "输出上限被思考吃光"与"provider/网络/鉴权失败"，而这两件事该给用户的建议完全相反。
- **正文为空时只重试一次**（含 `finish_reason=length` 的截断，以及实测到的第二种形态：
  `finish_reason≠length` 但 content 为空——思考写完了、正文没落地），重试预算
  `TURN_MAX_TOKENS_RETRY = 4096`；两次都空才停下。**绝不重试到成功。**
- **停止原因仍是既有闭集成员 `provider-failed`**（不趁修一个缺陷去扩展用户可见词表），
  但 `error` 如实区分 `output-truncated` / `empty-output`（运维含义完全不同），
  且空正文**不再触发**「密钥缺失」那条用户报错——模型回过话、只是没吐出正文，
  那不是配置问题。
  ⚠️ **这一条已被 D25 取代**：`error` 里的区分是对的，但把它留在 `provider-failed`
  仍然让**用户**看到"模型请求失败"。D25 把这两个码提升为正式的停止原因。
- **"截断但有正文"（半句话）不重试**：重试只针对"一个字都没有"，不为半句话多烧一次调用。

验证据此分两层：`tests/test_role_dm.js` 的 AE1–AE10 钉住预算、形状契约、重试的**有界性**
与两种成因的区分（执行器替身必须与生产**同形状**返回 `{text,truncated}`，否则测的是替身）；
真实模型端到端探针则给出 `firstSpeaker / sameThread / locksReleased / shortTurns / turnBudget`
全 PASS，自主发起只花 2 次调用（≤4），且**只读意图评估 0 次调用**。

## D25. 请求成功但没有正文 ≠ provider 故障：输出类失败成为正式停止原因（2026-09-15）

**D24 留了一个语义尾巴。** 它把 `output-truncated` / `empty-output` 放进了 `error`
（给运维看），但**停止原因**仍然是 `provider-failed`，于是**用户**看到的还是
「有一方没能回应（模型请求失败）」——明明 provider 成功了。用户据此去查的
key / endpoint / 网络，三个都没坏。**内部已经能识别的事实，用户看到的状态必须与之一致。**

契约面（先审计后修改，不新增第二套词表）：

| 层 | 位置 | 本轮 |
|---|---|---|
| canonical 词表 | `role-dm-core.js` 的 `REASON` | +2：`outputTruncated: 'output-truncated'`、`emptyOutput: 'empty-output'` |
| 运行时写入 | `role-dm.js` `runTurn()` | 只有"**有界预算 + 恰好一次重试**之后仍无正文"才成立；按 `truncated` 证据分码 |
| 用户文案 | `role-dm-ui.js` 的 `RUN_STOP_TEXT` | +2 条；**不含**密钥 / API Key / 网络 / 请求失败 |
| 自主判定词表 | `role-dm-social-core.js` 的 `REASON` | +2（与 core 逐字同码），于是 trace 的 `reasonCode` 说的也是事实 |
| 自主退避 | `role-dm-social.js` | 输出类失败**照样退避**（它真的花掉了 2 次调用） |
| 持久化 | `thread.stoppedReason` | 如实保存新码；旧 `provider-failed` 继续合法，**无迁移** |
| trace | 自主审计记录 | 无需改字段：`stopReason` / `blockedBy` / `reasonCode` 自动变准确 |

- **两种成因分开**（`truncated===true` → `output-truncated`；请求成功、无截断证据 →
  `empty-output`）。为什么不合成一个 `no-usable-output`：两者给用户的**建议不同**
  （前者该调思考档位 / 输出上限，后者只需稍后重试），而 `error` 里本来就有这条区分 ——
  这不是新造概念，是把既有的区分提升到用户可见层。
- **MB trace 的字段白名单没有动**（`middle-brain.js` 的 `_MB_TRACE_FIELDS` 是一份
  带追加纪律的冻结契约）。停止原因已经在 run 结果、thread 记录、自主审计 trace
  三处如实记录，不需要再占一个字段。
- **预算与重试策略冻结未动**：`2048 → (空) → 4096 × 恰好一次 → (仍空) → 停`。
  理由见 D24 §6 的同一条：自主私信不能因为推理模型没正文而进入隐性 token runaway。
- **"截断但有正文"仍然 0 次重试**：不为半句话多烧一次调用。

验证：0 次真实模型调用（成因已在 D24 用真实回包证过）。`test_role_dm.js` 269 绿
（AE7/AE10 按新码更新，新增 AF1–AF19：契约、真故障仍归 `provider-failed`、
持久化、旧码兼容、未知码安全 fallback、UI 文案与禁用词、**"检查密钥"卡片 0 张**
（同一间谍在真故障时确实抓到了卡片，证明它测的是生产路径）、manual/autonomous 同码、
重试上限 2 次调用）；`test_role_dm_social.js` 197 绿（新增 27b：自主路径的
stopReason / trace reasonCode 如实、退避照旧、账目不计）；`test_role_dm_smoke.js`
41 绿（**真实页面**上跑"请求成功但无正文"，断言渲染出的中文与非误导性，
且没有弹出错误卡片）；`test_frontend_structure.js` 全 PASS。

## D26. Provider 调用记账按 consumer 归属，不按 provider/model（RCI-1，2026-09-15）

### 决策
**同一 provider + 同一 model 不能证明属于同一个 consumer。** 模型调用的归属事实一律取
`IBModelCore.reasoningTrace` 的三元身份：`consumer` / `characterId` / `threadId`。
provider/model 只说明「走了哪条通道」。

### 理由
M3 Phase 3 的 24 次真实调用曾被按「isolated Role DM probe」记账，实际是 role_dm 19 +
diary planner 5：两者共用**同一个** provider/model（同一个注入配置），「按模型统计」于是
把并发的日记调用算成了私信调用。RCI-0 分类为 ISOLATION HARNESS DEFECT + OBSERVABILITY
DEFECT（不是产品 runtime bug）。

### 契约（`reasoningTrace` 记录）
- `consumer`：谁发起的。canonical `callApiChat*` 与 legacy `callApi` **都必须**声明；
  未声明（未知调用方）保留 `''`，不改成抛错 —— 观测闭包不得变成 runtime 校验。
- `characterId`：真实执行上下文里的角色 id（apiConfigs.id / Role DM 的 speakerId）。
  拿不到就写 `''`：**不猜、不从 prompt 解析、不从 model/provider 反推角色**。
- `threadId`：该次调用的会话/线程 id（Role DM 的 `thread.threadId`）。没有独立 runId
  就不为 trace 新建持久化 id。
- 三者只是 metadata：白名单键、只驻内存，绝不进入 provider 请求体。
- 每次真实 provider attempt 一条记录；重试产生多条**同身份**记录，不新增 attempt 计数器，
  也不新建第二套 request lifecycle。

### 验证
`tests/test_rci1_call_identity.js`（39 项，0 次真实模型调用）：legacy 六个调用点全部具名、
Role DM 双角色身份不串、预算重试身份不漂移、并发 diary/role_dm 同 provider/model 仍可区分、
trace 键白名单与请求体不含身份键。

> **2026-09-15 补注（RCI-1.1，commit `20ad52f`）**：本条的 `characterId` 契约在
> **Diary** 域也已落地 —— `generateDiaryEntry` 与 `_diaryDailyPlanner` 两条生产路径
> （consumer 恒为 `diary`，不碎片化成 `diary.entry` / `diary.planner`）现在如实传入 `cfg.id`；
> 身份取自配置 id，拿不到时写 `''`。**Diary 的 `threadId` 恒为 `''` 是有意设计**：
> Diary 没有会话线程概念，不为"看起来完整"制造假身份。
> 验证：`tests/test_rci1_1_diary_identity.js`（40 项，0 次真实模型调用）。
> 尚未声明身份的 consumer（`moments` / `role_letters` / `active.proactive` /
> `memory_consolidation` 等）仍为 `''`，**不得**记为已完成 —— 见 [ROLE_DM.md](ROLE_DM.md) §Observability。

## D27. familiarity 只授权"相处方式"，绝不授权"我们经历过什么"（Phase 4A，2026-09-15）

### 决策
角色私信的 `familiarity` **第一次**获得行为后果：`role-dm-core.js` 的
`buildFamiliarityGuidance(familiarity)` 把它投影成 system 里的一句话【相处方式】
（不必重新自我介绍 / 省掉陌生式客套）。**同时**确立 authority 分离：

| authority | 授权 |
|---|---|
| `familiarity` | 我们有多熟 → 开场方式 |
| history / thread memorandum | 我们**具体**经历过什么（事实） |
| publicProfile | TA 是谁 |
| self persona | 我是谁 |

四者不得互写。**familiarity 绝不授权编造具体共同经历** —— 高熟悉度只能让模型
"不必像初次见面"，不能让它说出"还记得我们上周一起去空间站吗"，除非那件事确实
存在于最近对话或 thread memorandum。

### 实现纪律
- 投影函数**只接受一个参数**（familiarity 数值）。它拿不到 history / memorandum /
  publicProfile / persona / 对用户的关系 —— 边界由**函数签名**保证，不是注释纪律。
- 阈值**复用既有词表**（0.2 = `RELATION_DEFAULT.familiarity`；0.7 = `describeRelation`
  的「非常熟」），**不新建第二套阈值**，也不新增第四档（0.7 档已由既有词表证明存在）。
- 基线以下 → **空串**：不注入任何熟人指导，因此不会凭空制造熟人关系。
- 输出是**行为指导**而非 persona、不含固定台词、**不含任何数值**；不改 publicProfile、
  不改 relationship 数值、不改 memorandum、不新增模型调用。
- `cfg.relationship`（角色↔用户）**绝不**参与：Phase 4A 只读 Role DM 的**有向**关系记录。
- 三个"关系后果"候选里只做这一个：**trust/disclosure 与 affinity/语气 留作 4B/4C**
  （尤其：**不**因为发现 `trust` 在当前实现里恒 ≥ 0.5 就顺手让它能下降，那是独立语义决策）。

### 验证
`tests/test_role_dm.js`（**390 绿 / 0 红**，新增 AF/A–D/DIR/E/F/H/I/J/K/M/MUT 共 36 项，0 次真实模型调用），
`tests/test_role_dm_social.js` **216 绿 / 0 红**。关键反例均为实测：方向对调 stance 消失（MUT-A）、
familiar 档强制关闭后 guidance 变空（MUT-B）。

## D28. 披露分级是**显式数据权威**，不从 persona 或 trust 推断（Phase 4B-1，2026-09-15）

### 背景
Phase 4B-0 只读审计（无代码改动）证明：`trust` 正常运行可达范围 = `[0.5, 1.0]`、
单向棘轮、无 decay；其 writer 读的是**本侧自己说的话**的 `toneCounts`，不是对方行为；
且当时**不存在**任何 disclosure / secretLevel / sensitivity / privateFact 数据模型。
因此"`trust < X` → 少透露"在生产中**永不触发**，且即使触发也只是软提示。
结论：需要先有**披露分级本身**，才能谈授权（classification first, authorization later）。

### 决策
1. **`publicProfile` = public by construction**（`public-profile-core.js` 构造式白名单）。
   它**不是**可被 gate 的私密事实；`disclosure-core.js` **不得**成为它的第二权威。
2. **persona / `systemPrompt` = 运行时身份权威**，**不是** disclosure 数据库。
   按关系裁剪 persona 等于改变角色身份，是语义错误，不是隐私保护。
3. **shared thread（memorandum / history）= 双方共同真相**，**不属于** self-secret gate。
4. **披露事实必须显式进入 classification contract**：
   `ownerCharacterId` 必须显式给出（不从 `createdBy` / `visibleTo` / `subject` 推断，
   缺失即整条拒绝）；`level` 必须精确命中封闭枚举 `PUBLIC|PERSONAL|PRIVATE|SECRET`。
5. **inferred / generated fact 不自动获得 private/secret authority**：
   仅 authored 来源（`character_authoring` / `user_authoring` / `user_correction`）
   可持 SECRET；其余一切来源（`memory_extraction` / `role_dm_conversation` / `diary` /
   `consolidation` / `generated_inference` / `unknown`）在归一化阶段**强制降为 PUBLIC**。
   这条由 `maxLevelForSource` 在**类型层**保证，下游不需要再检查。
6. **`trust` 暂时不是 authorization authority**，且本轮**完全未接入**
   （core 不读 trust / 不读关系；导出表里不存在 `authorize()` / `filter()` /
   `canDisclose()` —— "未实现"应当是**找不到函数**，而不是"有个函数永远返回 true"）。
7. **HARD boundary 必须发生在 prompt construction 之前**：
   未授权内容**从不进入**模型上下文；"模型看到内容 + 一句别透露"是
   **SOFT BEHAVIORAL GUIDANCE**，两者在文档里不得混称（承 D26 / 4B-0 术语契约）。
8. **legacy 缺 `level` ⇒ `UNDETERMINED`**（不进入披露子系统），
   **不是**默认 PRIVATE / SECRET —— 那会把每条没有元数据的旧记录都变成秘密，
   是 fail-**open** 到荒诞；也**不是**默认 PUBLIC。
9. **零 migration**：新字段是可选字段；旧记录不被读取、不被改写、不被分类。
   不因"看起来合理"给任何现有 Memory / persona 批量标 secret。

### 非目标（本轮）
不实现 authorization / filtering / trust gate / negative trust / decay；
不接 Role DM（`composeSide` / `buildRoleDmContext` 一行未动）；
不接 autonomous scoring / scheduler / M3 / Middle Brain / installer；
不调用真实 AI API；不用模型给现有数据分类；不新增第二套 publicProfile 权威。

### 验证
`tests/test_disclosure_core.js`（**111 绿 / 0 红**，0 次真实模型调用）：
enum closure / normalization（null·畸形·超长·控制字符）/ owner direction /
PUBLIC 不同于第二权威 / identity 边界 / shared-thread 边界 / legacy 默认 /
provenance 降级 / 序列化 / 结构性零 IO / mutation sensitivity（5 组真实变异，
含「undefined→PUBLIC」与「owner A→B」，均已实测能捕获）。
行为零变化由 `tests/test_role_dm.js`（**390 绿**）与 `tests/test_frontend_structure.js`（PASS）复核。

## D29. 披露敏感度需要**显式写者权威**：通道 ≠ 权威（Phase 4B-1.1，2026-09-15）

### 背景
D28 用 `source`（内容经过哪个通道）作为等级上限的唯一依据。本轮做了**只读 writer 审计**
（穷举所有可能产生"关于角色自己的事实"的生产 writer），结论是**不够**，而且不够的方式很具体：

| writer | file:line | 人类显式？ | 模型生成？ | owner 已知？ | 可持 PERSONAL？ | PRIVATE？ | SECRET？ |
|---|---|---|---|---|---|---|---|
| 角色编辑器（`systemPrompt` / `relationship`） | `social.js:1226-1237` →`_persistApiConfig` `social.js:710` | **是** | 否 | **是**（正在编辑 character A） | 否* | 否* | 否* |
| 角色编辑器（`publicProfile`） | `social.js:1237` →`public-profile-core.js` | 是 | 否 | 是 | **否**（PUBLIC BY CONSTRUCTION） | 否 | 否 |
| Memory 手工创建/编辑 | `memory.js:271 saveMemory`（`createdBy:'user'`）、`:735 _memInlineSave` | **是** | 否 | **否**（表单没有 character 维度） | 否† | 否† | 否† |
| Memory 模型抽取 | `memory.js:1494-1538 _generateMemoryCore`，`createdBy:cfg.id` | 否 | **是**（模型自己在 JSON 里选 `visibility`，`:1525`） | 否（`createdBy` 是角色 id，不是披露主体） | — | 否 | 否 |
| Memory 日记/信件派生 | `memory.js:1904 generateMemoryFromPost`、`:1934 generateMemoryFromLetter` | 否 | 是 | 否 | — | 否 | 否 |
| consolidation（episodic→semantic） | `active-diary.js:831 quickCreateMemory` | 否 | **是** | 否（`createdBy:roleId`） | — | 否 | 否 |
| Role DM 长期记忆 | `role-dm.js:1364`（`visibility:'only'`、`createdBy:roleId`、`source:'role_dm'`） | 否 | **是** | 否 | — | 否 | 否 |
| Role DM 自主 intent | `role-dm-social.js:419 computeIntent` | 否 | 否（纯本地打分，**不写任何 store**） | N/A | — | — | — |
| Understanding 派生 | `home-node/understanding-derivation.js`（唯一写者）；`memory.js:1053 unWrite` 在权威生效时**结构性拒绝** | 否 | 是 | 否（`characterId` 是"谁的理解"，不是"关于谁的事实"） | — | 否 | 否 |
| Understanding 用户更正 | `memory.js:1136 rejectUnderstanding` → `recordCorrection(..., basis:'user_stated')` | **是** | 否 | 是 | 否‡ | 否‡ | 否‡ |
| Role Letters 长期记忆 | `role-letters.js:236 _rlWriteRoleMemory`（独立 store，`owner=characterId`） | 否 | **是** | 是（仅该角色命名空间） | — | 否 | 否 |
| Moments / 动态 | `moments.js:568-580`（只**读**上下文） | 否 | 是 | — | — | 否 | 否 |

\* 不是"不允许"，而是**这些字段根本不是 disclosure fact 载体**：`systemPrompt` 是身份权威
（写成一个 disclosure fact 会被 `denylistHits` 整体拒绝），`relationship` 是角色↔**用户**关系。
† Memory 表单写的是 **ACL**（`public|only|except|private` + `visibleTo`），不是敏感度；
表单里没有任何"这条有多敏感"的输入。‡ 用户更正的对象是**理解**，不是角色事实。

表的读法（**精确，不要读成"人类通道也不行"**）：`—` = 该路径产生的记录在现有契约里
**连等级都拿不到**（派生权威 ⇒ 上限 PUBLIC），永远不可能持有；`否` = **现有代码里**没有
走到那一步，但原因是不同的两种：编辑器/表单**没有 disclosure 语义的入口**
（`systemPrompt` 是被拒载体的身份权威、Memory 表单写的是 ACL），
而用户更正**在本轮没有被接入本契约**（它今天写的是 Understanding correction，
不是 disclosure fact）。`human_authoring` 这个权威值是给"未来某个明确表示
'用户在创作一条披露事实'的 seam"预留的 —— 该 seam **今天不存在**（见决策 10）。

**审计中最重要的发现是同一个通道承载两种权威：**

```
用户显式写下   「设定：昔涟很怕打雷，这是她不愿告诉别人的事。」   ← 人类授权
模型在 Role DM 「我可能其实很怕打雷。」                          ← 模型自述
```

两者都可以经过同一条 `role_dm_conversation` / 同一张 `memories` 表。**若上限只看通道，
这两句话在类型上无法区分** —— 而区分它们正是本契约存在的理由。

### 决策
1. **`source` 与 `authority` 是两个维度，不得重载。**
   `source` = provenance（内容经过哪条通道）；`authority` = writer authority（谁负责）。
   把两者压成一个字段，等于让"经过哪条管道"悄悄变成"谁授权了它"。
2. **新增封闭枚举 `authority`：`human_authoring` / `human_confirmation` / `derived`。**
   畸形/缺失 ⇒ `derived`（fail closed 到"**没有人对它负责**"）。
3. **等级上限只由 `authority` 决定**：人类权威 → SECRET；`derived` → **强制 PUBLIC**。
   `source` **不再**单独决定任何上限。D28 第 5 条被本条取代（其 H 组行为仍逐字保留，
   见第 8 条）。
4. **通道与权威必须互相印证，两个方向都拒**（`authorityConflictsWithSource`）：
   非人类通道 + 人类权威 = 跨字段伪造；人类通道 + 非人类权威 = 自相矛盾
   （包括 `derived` —— 证据更多却结论更弱，说明调用方在猜）。整条拒绝，不静默改写任一维。
5. **`ownerCharacterId` 只能来自 writer context**，禁止从文本 / nickname /
   `subjectCharacterId` / `visibleTo` / `createdBy` / 当前最后一个 speaker 猜。
   审计结论是：**今天没有任何 writer 同时具备"明确 owner"与"明确 disclosure 动作"**，
   所以没有 writer 能创建 canonical disclosure fact。
6. **Memory ACL ≠ disclosure level，且不建立任何自动映射。**
   `visibility:'only'` ≠ PRIVATE、`visibility:'private'` ≠ SECRET、`createdBy` ≠
   `ownerCharacterId`。注意 `memory.js:1525` 处**模型自己在 JSON 里选 `visibility`**：
   这条 ACL 连"谁决定"都是模型 —— 若把它映射成等级，等于让模型一句话给自己发秘密。
7. **模型生成的事实只能成为 `candidate`，不能直接成为 canonical。**
   `MODEL OUTPUT → candidate → 人类显式确认 → authored fact`；**不是**
   `MODEL OUTPUT → SECRET`。`human_confirmation` 这个权威值就是为这条路径预留的语义，
   但确认流程本身**本轮不实现**（也不接任何模型调用）。
8. **legacy 兼容**：只给 `source`（4B-1 冻结形状）时，authored 通道 → `human_authoring`、
   其余 → `derived`，逐字保留 4B-1 行为；并且**归一化保持幂等**
   （归一化输出必须是自己合法的输入，否则契约是坏的）。
9. **`authoredBy` 是可选的旁证，不是授权本身** —— 这条限制写下来是因为它**看起来**像安全机制：
   在纯函数里任何人都能写下 `authoredBy:'user'`，所以"必须实名"拦不住想绕过它的人，
   只会制造一道**看起来像门**的检查。真正的授权载体是 `authority` + 通道的结构性事实
   （`character_authoring` / `user_authoring` / `user_correction` 只有人类写作路径能到达）。
   `authoredBy` 唯一被**拒绝**的情形是"derived 权威却带写者身份"（自相矛盾）。
10. **本轮选择 B（contract-only），不是 C（接一个 writer）。**
    选 C 需要先证明某个 UI/action 明确表示"用户正在创建 disclosure fact"。
    审计证明**不存在**这样的 seam：character 编辑器写的是 `systemPrompt`/`publicProfile`，
    Memory 编辑器写的是 ACL。把普通 Memory 编辑器"硬解释成"披露事实创作动作，
    正是本轮被明确禁止的事。因此：**零生产 writer**、**零消费者**。

### 非目标（本轮）
不实现 authorization / filtering / trust gate / negative trust / decay / 关系数值改动；
不接 Role DM（`composeSide` / `buildRoleDmContext` 一行未动）；不把 disclosure fact
注入 prompt；不自动抽取 private fact；**不调用模型判断"这是不是秘密"**；
不改 trust writer；不做 UI；不做 Memory migration；不碰 autonomous scheduler / M3 /
RCI-2 / installer / VERSION / dist。

### 验证
`tests/test_disclosure_core.js`（**149 绿 / 0 红**，0 次真实模型调用）：
4B-1 的 111 项逐字保留并全绿，新增 **L（20）/ M（5）/ N（11）** 共 38 项 ——
writer authority 契约（枚举封闭、上限只由权威决定、双向通道校验、拒因消歧、
9 字段序列化、幂等、4B-1 兼容适配器、授权函数仍不存在）、
逐 writer 反例（Role DM 自主文本 / diary / consolidation / memory extraction /
actions·letters / autonomous intent 六条真实路径各自不得升级）、
结构性（核心仍不读 trust·relationship·Memory、仍零 IO、全 `assets/js` 只有 core 自己
提到 `IBDisclosureCore`、HTML 仍未加载它）、**5 组新变异**：

| # | 变异 | 被哪条断言捕获 |
|---|---|---|
| MUT-A | `derived` 允许 SECRET | L1 / L8 / M-A |
| MUT-B | `visibility:'private'` → SECRET | MUT-B（映射出的 SECRET 仍被降为 PUBLIC）+ MUT-B2（等级不由 visibility 决定） |
| MUT-C | `createdBy` → `ownerCharacterId` 回退 | B3 / C 组 / MUT-C、MUT-C2（`visibleTo`/`subject`/`nickname` 同样不能冒充） |
| MUT-D | 未确认的 candidate → canonical PRIVATE | 通道校验（含 MUT-D1b：三个维度都得对上） |
| MUT-E | owner 回落到"当前说话人" | "UNKNOWN OWNER → REJECT" |

行为零变化由 `tests/test_role_dm.js`（**390 绿 / 0 红**）、`tests/test_role_dm_social.js`
（**216 绿 / 0 红**）、`tests/test_public_profile.js`（**87 通过 / 0 失败**）、
`tests/test_frontend_structure.js`（**PASS**）复核。

### 与 D28 的关系
D28 的**结论仍然成立**（分类是显式数据权威、不从 persona / trust 推断、
legacy 不自动成为秘密、publicProfile / persona / shared-thread 三域排除）。
D29 只修正 D28 的**依据**：等级上限从"来源"移到"写者权威"，因为审计证明
来源不等于权威。`disclosure-core.js` 里 `maxLevelForSource` 已被
`maxLevelForAuthority` 取代，并由 `authorityForSource` 作为**迁移适配器**
保留 4B-1 的调用形状语义。
