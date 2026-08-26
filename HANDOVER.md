# Internal Beyond · 交接文档（Agent 第一入口）

> 本文档回答「项目现在是什么情况、我接下来该干什么」。
> 深入阅读：[ARCHITECTURE.md](ARCHITECTURE.md)（怎么工作）· [DECISIONS.md](DECISIONS.md)（为什么这么设计，**含"不要随便改"清单**）· [CHANGELOG.md](CHANGELOG.md)（以前发生过什么）· [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（踩过什么坑）。
> 文档状态截至 **2026-08-26**。

## 1. 一句话定位

个人本地 AI 陪伴站：入口 [InternalBeyond.html](InternalBeyond.html)（无构建步骤，`file://` 直接打开），配套两个本地零依赖 Node 服务——Bridge 后端 [ib-bridge-service.js](ib-bridge-service.js)（23115：工具/看板/推送/AI 常驻/TTS）与 companion [active-message-service.js](active-message-service.js)（23114：后台主动消息计划、朋友圈调度、AI↔AI 回复链续推）。**是个人本地应用，不是 SaaS——不引入 RBAC/鉴权/多用户设计**（[DECISIONS.md](DECISIONS.md) D1）。

## 2. 当前状态

- **功能面**：主聊天（浏览器直连各家 API）、社交圈（Moments → Social Net：Feed/Profile/好友/讨论串/转发 + AI↔AI 回复链前后台）、AI 日记、记忆系统、工作区、游戏模块、行为观测层。全部模块已拆分完毕并注册 `window.IB` 命名空间。
- **测试基线全绿**：`node test-all.js --all`（static / service / browser 三组，约 150–165s）。改动后跑这个作为最终验收。
- **git**：基线 `e4074cc`、模块化检查点 `800411d`；2026-08-26 起发布到 GitHub 私有仓库（旧的"不碰 GitHub"约束已由用户解除）。
- **服务运行方式**：`start-bridge-service.cmd`（23115）、`start-active-service.cmd` / `start-local-services.cmd`（23114）。改配置后必须重启服务（配置只在启动时读取一次）。
- **用户配置实况**（2026-08-06 记录，需与用户确认是否更新）：酷狗 Cookie 已填但直连播放被服务端限制（走"打开酷狗"方案）；`tts.enabled=false`（未配真实 Key）；ntfy/bark 未启用；`lan=false`、token 空；旧式 proactive 关闭（AI 规划主动消息已替代）。配置在 `%LOCALAPPDATA%\InternalBeyond\bridge\config.json`（**含敏感值勿打印勿外传**）。

## 3. 当前正在进行的工作（观察期）

**行为观测层已上线（social-observe.js，纯旁路），正在等待 1–2 周真实分布数据回填，用于校准关系系统参数。**

- 待校准参数：relationship score 初值 / 正负增量 / 时间衰减 / 事件记忆阈值 / prompt 注入数量 / 高亲和短冷却阈值。
- ⛔ **禁止提前实现关系状态层**——这是明确的当前约束（[DECISIONS.md](DECISIONS.md) D13）。
- 数据查看：Moments 设置区开关 + 导出 JSON；控制台 `await _socialObsPrint(14)` / `await _socialObsStats(30)`；companion 侧文件 `%LOCALAPPDATA%\InternalBeyond\social-observe.json`。

## 4. 接下来做什么（候选，按建议优先级）

1. **观察期结束后的关系系统校准**（§3 的参数定值与实现）——唯一被明确规划的下一阶段。
2. **诚实清单中仍开放的缺口**（均为可选增强，非缺陷）：
   - companion 后台朋友圈仍只产纯文字（后台图文需在 Node 侧镜像 imageGen 请求逻辑）；
   - AI 社交通知类功能未做；moment 内容语义索引未做；
   - 日记调度仅在浏览器前端（companion 后台日记需 plans 同款机制）；日记特殊事件未全覆盖（生日/关系等级变化缺数据源，若未来加字段可补 `_diaryMaybeEvent` trigger 分支）；
   - Feed 扫描上限 360 之外的旧动态 UI 不再展示（可做时间范围查询）；
   - 可选收紧：逐步删除 window 双挂载（每删一个跑全套浏览器回归，[DECISIONS.md](DECISIONS.md) D6）。
3. **老清单遗留**（2026-08-06 审计标记）：#22 主聊天未接入服务端通用会话；输入状态条、MCP 按需加载等。
4. **可引导用户配置**（截至 08-06 未配）：TTS 真实 Key、ntfy topic、lan/token。

## 5. 必读关键信息（DO / DON'T）

### DON'T

- ❌ 仓库已发布为 **GitHub 私有仓库**（个人陪伴应用内容，勿改为 public）。提交前必须全量测试绿；不要 force-push（[DECISIONS.md](DECISIONS.md) D18）。
- ❌ **禁止提前实现关系状态层**（观察期未结束）。
- ❌ 不要试图恢复酷狗内嵌流式播放（服务端限制，[DECISIONS.md](DECISIONS.md) D3）。
- ❌ 不给项目加企业级设计（RBAC/token 鉴权/多用户隔离）。
- ❌ 测试清理时**不要动 23115 端口的用户服务**；测试写操作用 `IB_BRIDGE_DATA_DIR`/`IB_ACTIVE_DATA_DIR` 临时目录，勿污染真实数据（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) T8）。
- ❌ 不要删 Edge TTS 的本地 mock 验证方式而不重新验证协议（[TROUBLESHOOTING.md](TROUBLESHOOTING.md) T2）。

### DO

- ✅ 用**中文**交流。主要使用场景是 Android 手机（OPPO 等国产 ROM 需允许后台运行）：推送走 ntfy、健康走 Health Connect/HTTP Shortcuts。
- ✅ 用户对"看起来实现但实际没实现"非常敏感——交付前给代码证据与测试。
- ✅ 改 `InternalBeyond.html` 或 assets 下任一 JS/CSS 后检查/补回 **UTF-8 BOM**（edit 工具会剥掉，结构测试会拦）；新文件必须 BOM + UTF-8。
- ✅ 本地 file:// 验证改动用 **Ctrl+F5** 强刷。
- ✅ 大文件拆分/批量改写前：先建冒烟测试安全网 + 遵守失败原子性流程（先写新文件最后改父文件、留备份/Git blob）（[DECISIONS.md](DECISIONS.md) D16/D17）。
- ✅ 遇到任何报错先查 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)（本项目踩过的坑几乎都有记录）。

## 6. 常用命令速查

```powershell
# 重启 Bridge 服务
$c = Get-NetTCPConnection -LocalPort 23115 -State Listen
foreach($x in $c){ $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $x.OwningProcess); if($p.CommandLine -like '*ib-bridge-service.js*'){ Stop-Process -Id $x.OwningProcess -Force } }
Start-Process cmd.exe -ArgumentList '/c','start-bridge-service.cmd' -WorkingDirectory '<仓库根目录>'
Invoke-RestMethod http://127.0.0.1:23115/health

# companion（23114）同理：找监听进程确认 active-message-service.js 后停止，重跑 start-active-service.cmd
# companion 功能升级后必须重启一次才会启用新后台能力（否则浏览器自动本地回退，不会双发）

# 全量测试验收
node --check ib-bridge-service.js        # 快速语法
node scripts_check_html.js InternalBeyond.html
node test-all.js --all                   # 最终验收（--quick 约 17s）
```

常用路径：

- 配置/数据目录：`$env:LOCALAPPDATA\InternalBeyond\bridge\`
- 观测数据：`$env:LOCALAPPDATA\InternalBeyond\social-observe.json`
- 前端模块：`assets/js/`（加载顺序与命名空间约定见 [ARCHITECTURE.md](ARCHITECTURE.md) §2–3）
- 项目定位记忆：`project/local-app-positioning.md`

## 7. 已知限制与未验证项（诚实清单）

- Anthropic / Gemini / 真实 TTS / Bark / ntfy 只用 mock 或代码验证，未用真实 Key/设备端到端验证；Edge TTS 真实服务端在当前网络返回 403（地区限制，前端有 speechSynthesis 兜底）。
- 浏览器交互类（弹窗、拖拽手感、自动播放策略、定位授权）未人工实测。
- REST 接口无 token 鉴权（设计如此）；开 `lan` 时建议配 token + 防火墙/Tailscale。
- 主聊天由浏览器直连各家 API；Bridge 不做主聊天代理。
- 双执行器极小竞态（companion 误判离线 + DEL/PUT 双网络失败的理论窗口可能双发，消息 ID 秒级幂等兜底）——按定位接受。
- companion 无鉴权 + null-origin 放行（file:// 必需）的 PNA 理论风险——按个人本地应用定位接受。
- 无害噪音：`bg-canvas.jpg` 404、Cloudflare RUM 在 file:// 下报错。

---

*本文档只描述代码事实与已配置状态，不包含任何密钥原文。历史细节见 [CHANGELOG.md](CHANGELOG.md)。*
