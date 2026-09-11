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

