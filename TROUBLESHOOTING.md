# Internal Beyond · 故障排查与踩坑记录

> 本文档回答「以前踩过什么坑、怎么解决」。遇到问题先来这里查；机制背景见 [ARCHITECTURE.md](ARCHITECTURE.md)，设计取舍见 [DECISIONS.md](DECISIONS.md)。

## 排查入口速查（控制台日志锚点）

| 现象 | 先看什么 |
|---|---|
| API 编辑页头像问题 | 控制台 `API Editor character avatar:` 日志 |
| 日记生成失败 | 控制台 `[Diary] output unparseable:`（模型原始输出前 300 字） |
| Moments 生成失败 | `[Moments] output unparseable:` + `_momentsDiagnoseOutput` 结构化 JSON（stage 字段，见 T13） |
| 数据库升级阻塞提示 | toast/控制台 `onblocked` → 关闭旧标签页后刷新 |
| 服务是否存活 | `Invoke-RestMethod http://127.0.0.1:23115/health`（companion 为 23114 `/health`） |

---

## A. 服务与环境

### T1. 酷狗直连播放全部返回"需要付费"

- **现象**：`m.kugou.com/getSongInfo`、`wwwapi/play/getdata` 等接口在开发环境实测一律返回"需要付费"——免费歌也一样，带会员 Cookie 也无效。
- **结论**：酷狗服务端限制，暂时无解；当前配置里的 Cookie 是登录接口返回串，即使有效也被限制。
- **处置**：点歌走"打开酷狗客户端/网页"方案（深链是否唤起取决于本机是否安装酷狗）。不要试图改回内嵌流式（[DECISIONS.md](DECISIONS.md) D3）。

### T2. Edge TTS 从未正常工作过（两大实锤 bug + 403）

- **帧构造 bug**：旧实现 `header[1] = 0x80 | ssmlBuf.length` 用单字节编码载荷长度。SSML 实测 1526 字节被编码成 `0xf6`，服务端解出长度 118（1526 mod 128），帧必错乱。
- **数据丢弃 bug**：旧 `s.on('data')` 中握手之后的 TCP 段整体被丢弃（buf 每次重置），真实 Edge TTS 音频分多个 TCP 段到达，必收不全。
- **为何 mock 测不出**：mock 只验证请求体正确，没验证客户端 WS 帧打包逻辑。
- **修复**：新增 `wsFrame()`（mask + 126/127 双分支）+ 累积式帧解析循环 + `turn.end`/close 帧收尾 + finished 防重复 resolve。
- **真实环境 403**：当前网络直连 `speech.platform.bing.com` 返回 403（IP/地区限制，非代码问题）。修复后的行为：失败时前端 `_ibTtsSpeakImpl` 调用 `ibTtsFallback`（浏览器 speechSynthesis 降级），功能仍通。
- **验证方式遗产**：沙箱无法 spawn 子进程/连真实 Edge 时，本地 TCP mock 注入真实 WS 帧、分 3 个 TCP 段发送音频验证收全。**遗留：未在真实 Edge 环境端到端验证；切勿删掉本地 mock 验证脚本复制的改法而不重新验证协议。**

### T3. WebSocket close 帧发不出去

`close()` 必须先发 close frame 再置 `closed=true`。曾因顺序错误导致 close frame 发不出去，被测试抓出。已固化在 `bridge/ws.js` 的 WSConnection。

### T4. EADDRINUSE / 测试端口残留

- 早前有被强杀的测试进程残留占用 24000–25000 端口。再遇 EADDRINUSE：检查该区间 node 监听进程（命令行含 `ib-bridge-service.js` 或 `test_bridge.js`）并清理。
- **绝对不要动 23115 端口上的用户服务**。Bridge 启动本身对 EADDRINUSE 会自动换端口重试。

### T5. Companion 旧进程导致 PUT /moments 404

- **现象**：23114 持续 404，多个 friend_* ID 反复出现。
- **真因**：代码树路由正确（test_moments_http 对真实服务全过）；运行中的是功能上线前启动的旧版 companion 进程，其路由表没有 /moments。friend_* 就是 API Config（Role）ID，前端语义正确。
- **解决**：关闭旧窗口重跑 `start-active-service.cmd` 或 `start-local-services.cmd` 重启一次 companion。未重启期间浏览器本地调度照常工作。
- **已加固**：前端同步前 GET /health 能力预检（无 moments/reply_chains 字段判旧版 → 零 PUT 回退），循环内单角色 404/400 立即 break，不再 N 连发（DECISIONS D9）。

### T6. PowerShell 中文 body 变问号

PowerShell 5.1 的 `Invoke-RestMethod -Body` 发送中文默认按 Latin-1 转成 `?`。冒烟测试中文入参需用 `[Text.Encoding]::UTF8.GetBytes()` 构造 body，否则会误判"服务端中文坏了"。

### T7. 沙箱限制 spawn EPERM

受限沙箱下 `node --check` 单文件可用；但 `test_bridge.js` / `test_active_http.js` / 早期 `scripts_check_html.js`（execFileSync spawn 子进程）会报 `spawn EPERM`——**不是项目问题，是沙箱限制**。需验证主 HTML 全部内联 script 块时，提取各块单独跑 `node --check`。

### T8. 测试污染用户真实数据

校验 Bridge HTTP / companion 时务必用 `IB_BRIDGE_DATA_DIR` / `IB_ACTIVE_DATA_DIR` 指向临时目录再做写操作；结束时清理临时目录与测试监听进程。

### T9. 无害噪音报错（不用修）

- `bg-canvas.jpg` 404（背景图缺失）
- Cloudflare RUM 脚本在 `file://` 下 CORS/sendBeacon 报错
- 均不影响功能。

---

## B. 前端

### T10. UTF-8 BOM 被工具剥掉（高频复发）

- `edit` 工具改 `InternalBeyond.html` 或 assets 下任一 JS/CSS 后会把 UTF-8 BOM 剥掉——必须用 PowerShell 补回；新文件必须 BOM + UTF-8。
- 拦截网：`test_frontend_structure.js` 的 `encoding.bom.*` 断言。本项目已因此拦截过多次（core.css 拆分、game 拆分、social net 新文件等）。

### T11. "改动没生效"假象

本地 `file://` 打开页面时浏览器缓存很强。改配置/新增注入后务必 `Ctrl+F5` 强刷。

### T12. IndexedDB 升级被阻塞

控制台 `IndexedDB ... reading 'transaction'`：旧标签页持有旧版数据库连接，新页面升级被阻塞（db 未就绪走 localStorage fallback）。解决：关闭旧标签页后刷新。已加 `openDB` 的 `onblocked` 监听（控制台 + toast 提示）。

### T13. Moments/Diary 输出解析失败

- **日记**：只支持 JSON 解析导致文本格式输出报"无法解析"。已修：`_diaryParseOutput` 双格式解析（JSON 优先 + 「标题：/正文：/心情：」文本兜底）+ 重试提示 + maxTokens 1400→2000。
- **Moments**：诊断日志 stage 字段解读——
  - `empty-output` → 该角色 maxTokens/推理预算耗尽或 provider 适配器取不到 content（实锤案例见 T14）；
  - `no-json-object` → endpoint 可能吞掉 response_format；
  - `json-parse-failed` → 考虑提高 maxTokens（截断）；
  - `schema-publish-not-boolean` / `schema-empty-content` → 按需放宽字段类型。
- 解析矩阵已证明围栏/杂文包裹/publish:false 均可正常解析，先怀疑输出为空再怀疑格式。

### T14. reasoning 吃满 maxTokens 导致空输出（已修）

推理型模型先花 reasoning 再出 content，maxTokens=900 全被思考消耗 → assistant content 空。根因是 Moments 自己写死的 maxTokens:900（短正文 ≠ 小预算）。已修：`MOMENT_GEN_MAX_TOKENS=2000` + 首次 empty-output 重试预算加倍上限 8000（DECISIONS D12）。

### T15. api-thinking-hint 元素缺失引发头像空白

**根因**：`api-thinking-hint` 元素在 HTML 中不存在（历史遗留，仅 JS 引用），`editApi` 无保护访问抛异常中断，头像渲染代码从未执行。已修：两处（`editApi`/`addNewApi`）hint 访问加 if 保护；另加头像多字段兜底（avatar→avatarUrl→character.avatar/avatarUrl/image）+ 损坏头像 onerror 回退占位 + 调试日志。JS 已加空值保护不报错；若未来补回该元素，GLM 默认关闭/DeepSeek 默认开启的提示文字会恢复显示。**教训：仅 JS 引用而 HTML 中不存在的元素会让整条函数链静默中断。**

### T16. 多贴纸回退串名

AI 消息多贴纸时 `[sticker:A]` + PNG 加载失败的回退会串名（onerror 捕获的是循环末尾最后一个名字）。已改 IIFE 闭包捕获各自的贴纸名与元素。同类教训：循环内注册回调一律闭包捕获当次变量。

### T17. 表情弹窗监听器累积

document 级 click 监听器每次打开注册、只有点外部才注销，未点击关闭时累积。已抽 `_ibClosePop()` 统一注销。

### T18. ibTtsFallback 定义了但从未调用（文档与实现不符的历史）

README 曾宣称"浏览器语音降级"，但 `ibTtsFallback(text, btn)` 早已定义却没有任何调用点，实际从未生效。已在 `_ibTtsSpeakImpl` 失败/异常分支补上调用。**教训：交付前核对"声称的行为"有真实调用路径。**

### T19. Companion 快照缺 recent_moments 导致重复发帖

companion 执行发帖后若不把本次动态并入持久化快照 recent_moments，去重看不到自己刚发的内容，二次执行会重发。已在 `executeMomentSchedule` 成功分支修复。**教训：去重的输入集合必须包含自己刚产出的内容。**

### T20. Feed 分页"加载更多"永远回到 30 条

`_momentsRenderFeed` 最初每次调用重置分页计数。已改为 `{keepPage}` 语义。

### T21. CDP 里 Object.defineProperty 返回值报错

CDP 测试中 `Object.defineProperty` 的返回值是 window 对象，`returnByValue` 报 "Object reference chain is too long"。解法：用 IIFE 返回 true。

### T40. MiMo 图片注入 400 `base64 data is not valid`（2026-09-02 修复并官方端点复现验证）

- **现象**：MiMo `api.xiaomimimo.com/v1/chat/completions` 在 AI 朋友圈生成时回 400，`error.param = "messages[1] user content: the provided base64 data is not valid"`。
- **真因**：`_momentsImagePayload`(moments.js) 提取 mime 误写 `(String(src.match(...)||[])[1])`——`String(数组)[1]` 取的是字符串下标 1（即 `'a'`），导致 **mime 恒为 `"a"`**，`image_url` 变成 `data:a;base64,…` 被 MiMo 拒。
- **修复**：`moments.js` 改 `((src.match(...)||[])[1])` 正确取捕获组；`communication.js` `_adaptContentForApi` 强制 mime 为合法 `image/*`（`/^image\//i.test(p.mime)?p.mime:'image/jpeg'`）+ base64 去空白/剥重复 `data:…;base64,` 前缀。
- **验证**：`data:a;base64,…`=400（与报错逐字一致），`data:image/jpeg;base64,…`=200，官方端点实测 400→200。
- **排查**：Network→该 400→Response 的 `error.param`；或临时在 `_adaptContentForApi` 打 `[IB-DIAG] img mime=…`。
- **教训**：data URI 的 mime/捕获组提取勿用 `String(数组)[1]`；发给第三方端点的底层数据要校验（mime 白名单 + base64 清洗）。

---

### T41. Guide 功能模块 TOC 加子项后被 `max-height` 裁剪（只显示到某一项）

- **现象**：在 `InternalBeyond.html` 的 Guide「功能模块」Contents 折叠区新增几个子项（Active/Diary/Moments/Activities/语音，凑成 17 项）后，**展开仍只到旧的「Music」**，新增项不显示；刷新（Ctrl+F5）无效。
- **真因**：`assets/css/core/pages.css` 的 `.toc-sub.open{max-height:400px}` + `overflow:hidden`——子列表 17 项约 440px，**超出 400px 上限被 `overflow:hidden` 截掉**，并非 TOC 锚点/Q 没加。
- **修复**：把 `.toc-sub.open` 的 `max-height` 调大（本次改为 `1100px`，覆盖当前 + 未来再加项）；外层 `.guide-toc` 本身 `max-height:calc(100vh-140px); overflow-y:auto`，再多也能在视口内滚动，不撑破布局。
- **排查**：先确认源码锚点确实在 `#toc-sub-modules` 内（用 grep `gm-active|guide-local-services`），再查 `.toc-sub.open` 的 `max-height`/`overflow`——**"加了内容但联动样式没跟着涨"**是常见根因。
- **教训**：给 Guide TOC（或任何 `max-height`+`overflow:hidden` 的折叠展开容器）加子项时，需同步调大展开上限；`toggleTocSub`(core.js:332) 的展开逻辑不变（切换 `.toc-parent` 的 `nextElementSibling` `.toc-sub`）。

---

## C. 测试

### T22. test_active_plans 时钟敏感（白天过晚上挂）

原 `basePlan()` 默认 `respectDoNotDisturb = true` 且 DND 窗口 23:00–08:00——凌晨运行时到期计划会被顺延而非发送/取消，三个用例稳定失败（不是逻辑错，是环境时钟）。已修：basePlan 默认 false，DND 专项用例显式声明 true。
**经验：本套件对任务执行依赖系统当前时间；某用例白天过、晚上挂，优先查 DND/时间窗口；改造前先跑一次确认基线。**

### T23. openChatPanel 会从 IndexedDB 重载 apiConfigs

`openChatPanel()` 经 `renderChatPanelFriends → loadApiConfigs` 从 IndexedDB 重载 apiConfigs——直接 `apiConfigs.push()` 的测试配置会被冲掉。正确做法：`dbPut('apiConfigs', cfg)` 落库 → `loadApiConfigs()` → 再设 activeFriendId。

### T24. headless 下 confirm() 永久阻塞 CDP

`deleteLetter` 等会弹确认框，headless 下永久阻塞调用。测试开始时统一 `window.confirm=()=>true`。

### T25. 消息容器选择器随页面状态变化

迷你面板消息容器是 `#chat-messages`（`currentPage==='chat'` 时才是 `#chat-full-messages`）；断言用 `textContent` 而非 `innerText`（隐藏元素不在 innerText 里）。

### T26. _generateMemoryCore 挂起在审批 Promise 上

evaluate 需 fire-and-forget（IIFE 立即返回 true），再 waitFor 审批槽位（`_memoryApprovalQueue.length>=1 || _memoryApprovalActive!==null`；首个候选走 active 槽而非队列）。

### T27. 函数签名陷阱（按真实签名调用）

- `saveChatSummary(friendId, threadId, summary, coveredUpTo, …)` 是位置参数；
- `generateSummary(cfg, prevSummary, newMessages, charLimit, names)` 收 cfg 与新消息数组而非 friendId；
- `_wsRunJs(code, entry, files, timeout)` 的 entry 非空时 worker 校验 `files[entry]` 存在（内联代码要传 `entry:''`）；
- `_parseWsOps` 返回 `{cleanText, ops, files}` 对象而非数组。

### T28. lastPostAt 先于去重拦截

45min 最短发布间隔会先于内容去重拦截（真实场景正确）。去重单测需显式清零 lastPostAt。

### T29. UI 回归焦点检查时序 flake

全量负载下固定等待 150ms 会 flake。已改为最多 1.5s 等待目标控件实际聚焦（验收条件不变），连续单测 3 次通过。**经验：断言交互结果时等待"实际状态达成"而非固定时长。**

### T30. 结构断言用 includes 不用正则

三层转义（run_code 模板 / write / pwsh）把正则搞得不可靠，结构测试的 IIFE 首尾标记断言用 includes 零转义更稳。AI 指令串断言避免在 evaluate 表达式里写真实换行（同因）。

---

## D. 工厂注入与迁移事故（高危，勿重蹈）

### T31. 提取脚本的失败原子性事故（memory.js 数据丢失与恢复）

- **事故**：首次提取 memory/auto-memory 时，Node 脚本先改写了 memory.js（切块成功），随后写新模块文件时因目录不存在抛 ENOENT——切块内容只在进程内存，随失败丢失；当时 git 无 assets（未跟踪）、无其它备份，自动恢复一度无解。
- **恢复路径（成功）**：
  1. DSH 会话转录（`%USERPROFILE%\.dsh\sessions\...\session.jsonl.zstd`）——zstd 帧可手工解析（node:zlib zstdDecompressSync），从历史 read 结果回读片段；
  2. **Cursor 本地 AI 记录（决定性）**：`%APPDATA%\Cursor\User\globalStorage\state.vscdb` 的 cursorDiskKV 表 composer.content / inlineDiffUndoRedo 内含 memory.js 全文件（迁移前版本）；与磁盘保留行逐行比对（1544 行仅 5 处已知差异 = 后加的重构，均在保留区）；
  3. 重组后与全部 524 个已知行 100% 一致、node --check 通过，恢复后重新执行提取。
- **固化的流程规则**（详见 DECISIONS D16）：先 mkdir；先写新文件最后改父文件；父文件改写前留存完整备份/Git blob；批量改写前确认有可回退副本。

### T32. 切片误删 IIFE 开括号（communication.js letters 提取）

切片时 RemoveRange 把目标文件自己的 `(function(NS){` 开括号一并删掉（覆盖了第 3 行），语法检查报末尾 `Unexpected token '}'`。补回后恢复。
**教训：切片边界要先把目标文件的包裹行排除在删除范围外。** 结构测试 com./ws./mem./active.* 断言（IIFE 首尾标记，includes 实现）就是为此加的护栏。

### T33. 区域限定的名字剔除范围

letters 提取时按名字全局剔除是安全的（无内部消费者）；voice/annotations 在 communication.js 内还有代码行引用（`_buildVoiceEl(m.voice)` 等），剔除必须只作用于双挂载标记行之后。**教训：从 attach 标记行起才按名字过滤。**

### T34. calendar.js 被误判为顶层脚本

calendar.js 初看像顶层脚本（内部代码列 0 缩进、扫描器把 IIFE 内部声明当成顶层），实际整个文件外包了 IIFE——第一版误加外层包裹导致 attach 块 `$ is not defined`，被 `runtime.noGameExceptions`/`runtime.noJsErrors` 当场抓出，回滚为标记迁移。
**教训：批量迁移前先确认文件是否已有 IIFE 包裹（看文件头是否有 `(function(){`）。**

### T35. 'use strict' 序言位置

game 六文件带有顶层 `'use strict'`：IIFE 开括号必须插在文件头注释**之前**，保持 strict 指令的序言位置（注释允许出现在指令前），否则严格模式语义丢失。

### T36. resetStateForTest 与工厂闭包冲突

active/persistence 首版把 state 放进工厂闭包，但测试钩子 `resetStateForTest` 会重新赋值 state，被 `Assignment to constant variable` 当场抓出。已统一 getter 注入（`getState: () => state`）。同理 bridge/routes 用 getter/setter 注入会被重新赋值的路由状态（DECISIONS D4）。

### T37. diagnosticsSnapshot 闭包遗漏

bridge/config.js 提取时 `diagnosticsSnapshot` 引用了移入工厂闭包的 `configInvalid`，首跑被 82 项断言抓出（diagnostics.snapshot 失败），已把 configInvalid 加入工厂导出。**教训：工厂导出面要覆盖所有闭包内状态的读取方。**

### T38. Node 24 拒绝未知扩展

active-diary 拆分预检时临时文件用 `.next` 扩展被 Node 24 拒绝。改用 `.next.js`。

### T39. PowerShell 字符串拼接坑

`$n:` 需要 `${n}`、单引号转义、JS 模板字符串与 pwsh 反引号冲突——命名空间迁移脚本已沉淀为可复用函数，后续批量脚本直接复用。

---

## E. 运维备忘

- 强制刷新页面用 `Ctrl+F5`（见 T11）。
- 看到"数据库升级被其他标签页阻塞"：关闭旧标签页后刷新（T12）。
- 改配置后必须重启对应服务（配置只在启动时读取一次）。
- companion 功能升级后（如 moments/reply_chains 上线）：重启一次 companion 才能启用后台能力；未重启期间浏览器自动本地回退，不会双发（T5）。
