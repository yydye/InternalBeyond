# P2 · Degraded Startup / Boot State —— 完成报告

> 阶段目标：**Bridge / Active 等非致命本地服务异常时，主 UI 仍然必须能打开；同时建立可靠、机器可读的启动状态，让 P5 Diagnostics 准确知道"什么正常、什么降级、为什么"。**
>
> 状态：**P2 完成，停在 P2，未进入 P3。**
> 基线：`<repo-root>`（master，工作树含其他会话未提交改动）。
> 约束遵守：未触碰 `InternalBeyond.html`、`assets/js/middle-brain.js`；未修 `.gitignore` 既有编码损坏；未重构 `local-services-runner.js`；未实现 Diagnostics 页面 / 向导 / Provider UI / Vision 安装器 / Electron。

---

## 1. 修改文件

**新增**

| 文件 | 作用 |
|---|---|
| `boot-state.js` | boot-state 状态契约：构建 / 脱敏 / 原子写 / 读取 / 陈旧判定（launcher 与静态服务共用，单一事实源） |
| `test_boot_state.js` | P2 专项测试（36 项，真实 HTTP 服务 + 真实静态服务 + 真实 launcher 决策路径） |
| `test_boot_smoke.js` | 最小浏览器 smoke（11 项，headless Chrome/Edge + CDP） |
| `docs/history/zero-setup/P2-BOOT-STATE-REPORT.md` | 本文档 |

**修改**

| 文件 | 改动 |
|---|---|
| `launch-internal-beyond.js` | G10 修复：可选服务失败 → degraded 且照常打开 UI；静态层失败 → fatal；写 boot-state（starting → complete）；运行时/管理器信息；异常兜底 |
| `internal-beyond-server.js` | 新增只读 `GET /__boot-state`（同源、`no-store`、读取时再次脱敏） |
| `test_launcher.js` | 复用路径断言 `overall=normal`；boot-state 写入隔离到临时目录（不再污染真实 `%LOCALAPPDATA%`） |
| `test-all.js` | 登记 `test_boot_state.js`（static）、`test_boot_smoke.js`（browser），分组计数 33 / 16 / 46 |
| `README.md` | 新增「降级可用 + boot-state」说明，端口一览补 `23116`，日志路径与失败语义更正 |

**未改动（遵守约束）**：`local-services-runner.js`、`ib-bridge-service.js`、`active-message-service.js`、`启动 InternalBeyond.vbs`、`Start Internal Beyond.cmd`、任何前端脚本、任何 provider metadata、`.gitignore`。

---

## 2. G10 原始根因

`launch-internal-beyond.js`（P2 前，`main()` 第 198–204 行）：

```js
const servicesReady = await waitFor(...25s...);
if (!servicesReady) {
  errorBox('Local services did not become healthy. Bridge=offline…');
  return { ok: false, reason: 'services' };   // ← 在 openBrowser() 之前返回
}
...
if (!o.noOpen) openBrowser(o.url || WEB_URL);  // 永远到不了
```

根因不是"健康检查写错了"，而是**编排顺序把可选依赖放在了主 UI 之前，并且用同一个 `ok:false` 通道表达两种完全不同的失败**：

1. 打开浏览器是 `main()` 的最后一步，任何前置失败都直接 return；
2. Bridge/Active 是**可选能力**（主聊天是浏览器直连厂商 API；`README` 亦标注 Bridge 为可选），却被当成启动前置条件；
3. 失败只有一条路径：英文 `MessageBox` + 退出码 1，用户面对的是"软件打不开"，而不是"某个能力不可用"。

**依赖事实（按真实代码核对，未凭名称判断）**

| 组件 | 真实依赖关系 | 判定 |
|---|---|---|
| 静态 Web（`internal-beyond-server.js`, 23120） | 主 UI 的唯一提供者；`InternalBeyond.html` 只能从它加载（`file://` 下 AudioWorklet 被拒） | **fatal**（无法提供 → 无 UI） |
| bundled Node（P1） | 启动器与服务的执行前提 | **fatal**（VBS 层已处理） |
| Bridge（23115） | `assets/js/bridge.js` 的 DIY 后端连接、工具/支付/TTS 等；主聊天不经过它 | **degraded** |
| Active（23114） | `assets/js/active-diary.js` 的陪伴/主动消息；失败已有 toast 降级 | **degraded** |
| 重启控制面（23116） | 前端「重启后端」按钮；纯可选 | 信息项（不参与 overall） |
| Vision（8765） | 高级可选，启动器默认不启动 | 信息项（`not-enabled`） |

结论：**用户给定的 fatal/degraded 边界与真实代码一致，未发现冲突，因此未扩大修改。**

---

## 3. 新的 fatal / degraded 判定规则

```
启动
 ↓ 解析 Node 运行时（IB_NODE → runtime\node\node.exe → PATH）    ← P1，失败即 fatal（VBS 弹窗退出）
 ↓ 写 boot-state phase=starting（立刻作废旧记录）
 ↓ 探测/启动 Bridge + Active（有界等待，默认 25s）
 ├─ 全健康 → normal
 └─ 否则   → degraded（记录每项真实状态与原因；**不阻断**）
 ↓ 静态层：身份 + 主页面可服务性
 ├─ 端口被陌生进程占用 / 起不来 / 主页面 404 → fatal（不打开任何 URL）
 └─ 正常 → 打开 UI
 ↓ 写 boot-state phase=complete（overall / degradedReasons / fatal）
```

**判定表**

| 条件 | overall | 是否打开 UI |
|---|---|---|
| 静态层健康 + Bridge/Active 健康 | `normal` | 是 |
| 静态层健康 + Bridge 和/或 Active 异常（offline / timeout / conflict / probe-failed） | `degraded` | 是 |
| 静态层健康 + 重启控制面 / Vision 异常 | `normal`（信息项，`affectsOverall:false`） | 是 |
| 静态层端口被陌生进程占用 | `fatal`（`port-conflict`） | 否 |
| 静态服务起不来（spawn 失败 / 轮询超时） | `fatal`（`static-unavailable`） | 否 |
| 静态服务身份正确但主页面无法提供 | `fatal`（`ui-document-unavailable`） | 否 |
| 启动器自身未预期异常 | `fatal`（`launcher-error`） | 否 |
| Node 运行时不可用/版本过低 | `fatal`（VBS 层，无 boot-state） | 否 |

**硬约束（已实现并测试）**：`components.static.required === true` 且不健康时，`buildBootState()` 会**强制**推导 `fatal` —— 契约本身无法写出"静态层挂了却是 normal"的记录。同时**没有任何代码路径伪造 Bridge/Active 健康**：状态全部来自 runner `--json` 的真实 `/health` 身份校验（Bridge `server==='IB Bridge'`，Active `service==='internal-beyond-active-messages'`），端口被陌生进程占用判为 `conflict` 而非 healthy。

---

## 4. `boot-state.json` 完整 schema 示例

```jsonc
{
  "schema": "internalbeyond.boot-state",   // 固定串，P5 用它做版本校验
  "version": 1,                            // 契约版本；只增字段不改语义
  "bootId": "20260909T004628413Z-7aad3d",  // 每次启动唯一，用于识别"本次启动"
  "generatedAt": "2026-09-09T00:46:33.442Z",
  "phase": "complete",                     // starting | complete
  "overall": "degraded",                   // starting | normal | degraded | fatal
  "ok": true,                              // overall !== 'fatal'
  "opened": true,                          // 本次是否真的发起了打开 UI
  "degraded": true,
  "staleAfterMs": 43200000,                // 记录自带的保鲜窗口（12h）
  "launcher": {
    "pid": 29844,
    "startedAt": "2026-09-09T00:46:28.413Z",
    "finishedAt": "2026-09-09T00:46:33.442Z",
    "root": "E:\\InternalBeyond-main",
    "platform": "win32",
    "arch": "x64",
    "node": {
      "path": "E:\\InternalBeyond-main\\runtime\\node\\node.exe",
      "version": "v24.18.0",
      "source": "bundled",                 // bundled | IB_NODE | PATH
      "bundled": true,
      "requiredMajor": 18,
      "ok": true
    },
    "serviceManager": {                    // Bridge/Active 的父进程
      "state": "starting",                 // unknown | healthy | starting | down
      "wasRunning": true,                  // 探测时已有管理器
      "startedByLauncher": false,          // 本次是否由启动器拉起
      "error": null                        // 或 {category, message}
    }
  },
  "components": {
    "static": {
      "required": true, "affectsOverall": true, "probed": true,
      "healthy": true, "state": "healthy", "reason": null,
      "host": "127.0.0.1", "port": 23120,
      "url": "http://127.0.0.1:23120/InternalBeyond.html",
      "identity": "InternalBeyond Web", "reused": true
    },
    "bridge": {
      "required": false, "affectsOverall": true, "probed": true,
      "healthy": false, "state": "conflict",
      "reason": { "category": "conflict", "message": "port 13791 answered but is not Bridge" },
      "port": 13791
    },
    "active": {
      "required": false, "affectsOverall": true, "probed": true,
      "healthy": false, "state": "conflict",
      "reason": { "category": "conflict", "message": "port 13792 answered but is not Active" },
      "port": 13792
    },
    "restart": {
      "required": false, "affectsOverall": false, "probed": true,
      "healthy": true, "state": "healthy", "reason": null,
      "port": 23116, "controlState": "idle"
    },
    "vision": {
      "required": false, "affectsOverall": false, "probed": false,
      "healthy": false, "state": "not-enabled",
      "reason": { "category": "not-enabled", "message": "Vision is an optional extra and is not started by the launcher" },
      "port": 8765
    }
  },
  "degradedReasons": [
    { "component": "bridge", "category": "conflict", "message": "port 13791 answered but is not Bridge" },
    { "component": "active", "category": "conflict", "message": "port 13792 answered but is not Active" }
  ],
  "fatal": null,                           // 或 { category, message }
  "warnings": []                           // [{ code, message }]，如 runner-unavailable / spawn-failed
}
```

**词表（稳定，P5 可直接渲染）**

- `overall` / `phase`：见上。
- 组件 `state`：`healthy | offline | conflict | unknown | not-enabled | error`
- `reason.category`：`none | offline | conflict | timeout | starting | unknown | not-enabled | runner-unavailable | spawn-failed | probe-failed | port-conflict | static-unavailable | ui-document-unavailable | launcher-error | permission-denied | path-unavailable | disk-full | write-failed`
- 读取端 `staleReason`：`null | missing | invalid | age | clock-skew | abandoned-start | web-port-mismatch`
- `probed:false` 表示"本次启动未探测该组件"，**不是错误**（P5 不要渲染成红色）。
- `affectsOverall:false` 表示该组件不参与 overall 判定（restart / vision）。

---

## 5. 文件实际位置与生命周期

| 项 | 值 |
|---|---|
| 路径 | `%LOCALAPPDATA%\InternalBeyond\boot-state.json`（非 Windows：`~/.internal-beyond/boot-state.json`） |
| 覆盖 | 测试/排障可用 `IB_BOOT_STATE_DIR` 指定目录 |
| 复用约定 | 与 runner 的 `%LOCALAPPDATA%\InternalBeyond\logs\{bridge,active}.log`、`credential-vault.json` 同一 per-user 状态目录；正式安装到只读目录也能写 |
| 生命周期 | 每次**正式启动**两次写入：① 启动瞬间写 `phase=starting`（作废旧记录）；② 分类完成写 `phase=complete`。进程中途崩溃 → 文件停在 `starting`（读取端报 `abandoned-start`），不会冒充 normal |
| 读取接口 | `GET http://127.0.0.1:23120/__boot-state`（同源、只读、`Cache-Control: no-store`、无 CORS 头） |
| 不写入的内容 | API Key / Token / Authorization / Cookie / 密码 / 私钥 / 聊天内容 / 角色提示词 / 完整环境变量 |

---

## 6. Normal 启动实测

**A. 分类单测（真实 HTTP 健康服务 + 真实静态服务 + 真实 `main()`）**

```
✓ 1) Bridge + Active healthy → overall=normal, UI served
      components.static.healthy=true reused=true, bridge/active healthy,
      degradedReasons=[], 磁盘记录 overall=normal
```

**B. 真实 Windows 启动链（真实 `启动 InternalBeyond.vbs` → 内置 Node → 真实服务 → 真实静态服务）**

```
IB_LAUNCH_NO_OPEN=1 cscript //nologo "启动 InternalBeyond.vbs"   → VBS_EXIT=0
[VBS] node runtime resolved: src=bundled path=…\runtime\node\node.exe
[VBS] node version: v24.18.0
overall=normal opened=false static=healthy bridge=healthy active=healthy reasons=[]
```

（`opened=false` 是因为显式设置 `IB_LAUNCH_NO_OPEN=1` 抑制开浏览器，避免多余标签页；浏览器打开路径见第 9 节与第 6 节 A 的 `opened:true`。）

---

## 7. Bridge 单故障实测

真实 HTTP 服务占位（Bridge 端口指向一个身份不符的真实服务），其余真实：

```
✓ 2) Bridge down → UI still opens, overall=degraded
      bridge.healthy=false, reason.category=conflict|offline|timeout
      active.healthy=true, static.healthy=true, result.ok=true
      url=…/InternalBeyond.html
```

---

## 8. Active 单故障实测

```
✓ 3) Active down → UI still opens, overall=degraded
      active.healthy=false（reason.category 为 conflict/offline/timeout）
      bridge.healthy=true, static.healthy=true
```

---

## 9. 双故障实测 + 真实降级启动链（UI 确实被打开）

**A. 分类单测**

```
✓ 4) Bridge + Active down → UI still opens, overall=degraded
      degradedReasons = ['active','bridge']（顺序稳定）
```

**B. 真实 Windows 启动链（真实 VBS + 真实静态服务 + 真实浏览器）**

```
IB_BRIDGE_PORT=13791 IB_ACTIVE_PORT=13792 IB_LAUNCH_SERVICES_TIMEOUT_MS=4000 \
  cscript //nologo "启动 InternalBeyond.vbs"        → VBS_EXIT=0

[2026-09-09T00:46:33.419Z] Services state: Bridge=conflict, Active=conflict, manager=starting.
[2026-09-09T00:46:33.428Z] Web server healthy (reused=true).
[2026-09-09T00:46:33.429Z] Opening http://127.0.0.1:23120/InternalBeyond.html
[2026-09-09T00:46:33.448Z] Degraded launch: bridge=conflict, active=conflict

boot-state: overall=degraded ok=true opened=true
            node.source=bundled version=v24.18.0
            static=healthy(reused) bridge=conflict active=conflict restart=healthy(vision=not-enabled)
浏览器进程数 23 → 24（真实新开）
GET http://127.0.0.1:23120/InternalBeyond.html → 200, 404061 bytes
```

**P2 前同样场景**：25s 后 `errorBox` + `return {ok:false}` + 退出码 1，**UI 完全不打开**。现在是退出码 0 + UI 正常打开 + 降级原因可读。

---

## 10. Static fatal 实测

三种独立成因，全部 `fatal` 且**不打开任何 URL**：

| 场景 | 结果 | 真实链验证 |
|---|---|---|
| 端口被陌生进程占用 | `fatal` / `port-conflict` | **真实 VBS**：`IB_WEB_PORT=4200`（被外来服务占用）→ `VBS_EXIT=1`，`overall=fatal ok=false opened=false`，`fatal={"category":"port-conflict",…}`，无浏览器 |
| 静态服务起不来 | `fatal` / `static-unavailable` | 单测：spawn 被拦截 + 短超时 → fatal，`browserOpens.length===0` |
| 身份正确但主页面无法提供 | `fatal` / `ui-document-unavailable` | 单测：`/health` 身份正确、`/InternalBeyond.html` 404 → fatal，`browserOpens.length===0` |
| 启动器未预期异常 | `fatal` / `launcher-error` | 单测：注入一次 `buildBootState` 抛错 → fatal 落盘，不留下 `starting`，不打开 URL |

---

## 11. stale / atomic-write / write-failure 行为

**原子写**：`tmp(同目录) → writeFileSync → fsync → rename`；Windows 下 `rename` 覆盖被读进程短暂占用会返回 `EPERM/EACCES/EBUSY`，因此加了**有界重试**（6 次 × 25ms，同步等待）。测试：60 次写入与并发读取交错 → 每次读取都是合法 JSON（0 次半截），目录无 `.tmp` 残留。

**stale（旧记录不得冒充本次启动）**

- 启动瞬间先写 `phase=starting` → 旧记录立刻失效；崩溃也只停在 `starting`。
- 单测实测：预置一条 3 天前的 `overall=normal` 记录 → 启动后 `bootId` 变化、`generatedAt` 刷新、`overall=degraded`，且轮询**观测到 `starting` 中间态**。
- 读取端 `GET /__boot-state` 返回 `stale` + `staleReason`：

| staleReason | 触发 |
|---|---|
| `missing` | 文件不存在（例如静态服务被手工启动） |
| `invalid` | 非法 JSON / 非对象 / 超过 256 KB |
| `age` | `generatedAt` 超过记录自带的 `staleAfterMs`（默认 12h） |
| `clock-skew` | `generatedAt` 比当前时间超前 > 5 分钟 |
| `abandoned-start` | `overall=starting` 且超过 2 分钟（启动中断） |
| `web-port-mismatch` | 记录里的 `components.static.port` ≠ 当前静态服务监听端口 |

实测（真实 per-user 文件 + 新启动的静态服务实例）：记录为 4200、服务在 4213 → `stale=true, staleReason=web-port-mismatch`。

**写入失败不阻断**：状态目录不可写（用"父路径是文件"制造 `ENOTDIR`）时 → `main()` 仍 `ok:true / overall=normal`，`bootStateWrite.ok=false` 且带 `error.category`，失败只进 `logs\launcher.log`。`writeBootState` 对任何非法路径都不抛异常。

---

## 12. 脱敏验证

| 验证 | 结果 |
|---|---|
| `scrub()` 丢弃密钥形键名（apiKey/token/authorization/secret/password/cookie/private_key…） | ✓ 键消失，非敏感字段保留 |
| 掩码密钥形值（`sk-…`、`Bearer …`、`AIza…`、`ghp_…`、JWT） | ✓ 全部替换为 `***` |
| 写入文件的文本不含密钥形内容 | ✓ |
| **不复制服务 `/health` 原始载荷**：只取 `version` 字段（runner 行里的 `details` 一律不落盘） | ✓ 测试用返回 `{apiKey:'sk-live-…'}` 的健康服务，文件内无该值 |
| 读取端二次脱敏：手工往 `boot-state.json` 塞 `apiKey` / `Bearer …` | ✓ `/__boot-state` 响应中已被丢弃/掩码 |
| 记录中不存在 `env` / 完整命令行 / 聊天内容 / 角色提示词 | ✓（结构里根本没有这些字段） |
| 端点无 CORS 头（跨源页面无法读取）、`no-store` | ✓ |

---

## 13. P1 bundled Node 回归

| 项 | 结果 |
|---|---|
| `node test_node_runtime.js` | **17 通过 / 0 失败**（含"runner 仍用 `process.execPath` 启动服务、launcher 仍以 `process.execPath` 隐藏窗口拉起子进程"两条无回归断言） |
| 真实链 Node 来源 | `source=bundled`、`version=v24.18.0`、`path=…\runtime\node\node.exe` |
| 服务继承 | 未改动 `local-services-runner.js`；P1 已实证 Bridge/Active 的 `ExecutablePath` 为内置 node，本次未触碰该路径 |
| 开发 fallback | 未改动 VBS / `.cmd`；PATH node 仍可用（`test_launcher.js` 即以 PATH node 运行） |

---

## 14. 完整测试结果

| 测试 | 结果 |
|---|---|
| `test_boot_state.js`（P2 专项，36 项） | **36 通过 / 0 失败**，18s，自然退出（无泄漏报告） |
| `test_boot_smoke.js`（最小浏览器 smoke，11 项） | **11 通过 / 0 失败**，3s |
| `test_launcher.js`（launcher + 静态服务回归） | **16 通过 / 0 失败** |
| `test_node_runtime.js`（P1 链） | **17 通过 / 0 失败** |
| `node test-all.js --quick`（一次完整 static + service 回归） | static **33 项 · 1 失败**，service **16 项全部通过**；唯一失败见下 |

**唯一失败项与 P2 无关（证据）**

```
FAIL  encoding.bom.assets\js\middle-brain.js  -> UTF-8 BOM is required
HEAD   : ef bb bf   （有 BOM）
工作树 : 2f 2a 20   （无 BOM，被其他会话改动：29 insertions(+), 5 deletions(-)）
```

`assets/js/middle-brain.js` 是**并行会话在途文件**（`git status` 显示 ` M`，P1 报告已记录同一现象）；P2 未触碰任何前端文件。

**最小浏览器 smoke 覆盖**（P2 不涉及前端功能，故不跑 45 项 browser suite）：

```
✓ 静态服务提供真实主页面（#app + #page-chat 渲染）
✓ 前端模块加载（window.IBNET / window.PROVIDERS）+ 40+ script 全部执行
✓ degraded 状态下页面仍可用、无启动阻断
✓ 页面同源读取 /__boot-state：present=true, stale=false, overall=degraded, bridge=offline
✓ 无未捕获页面异常
```

**测试策略**：开发期只跑最小相关专项；完整 static/service 回归只在交付前跑一次（本次）；未跑完整 browser suite（按 P2 约束）。

---

## 15. 已知限制 / P5 需要消费的接口

### 15.1 P5 消费接口（唯一状态模型，禁止再造第二套）

```http
GET http://127.0.0.1:23120/__boot-state      # 同源，只读，no-store，无 CORS
200 {
  "ok": true,                 // 记录可读（present && 解析成功）
  "present": true,
  "stale": false,             // true 时**不得**当作本次启动状态展示
  "staleReason": null,        // missing|invalid|age|clock-skew|abandoned-start|web-port-mismatch
  "ageMs": 1234,
  "schema": "internalbeyond.boot-state",
  "version": 1,
  "path": "C:\\Users\\…\\AppData\\Local\\InternalBeyond\\boot-state.json",
  "error": null,              // 或 {category, message}
  "bootState": { …第 4 节完整对象… }
}
```

渲染建议：`overall` 决定页面顶部横幅（normal / degraded / fatal）；`components.*.healthy + state + reason.category` 决定每行；`degradedReasons` 直接给"为什么降级"；`stale===true` 时显示"状态可能不是本次启动"而不是假绿。**`probed:false` 与 `affectsOverall:false` 不得渲染成故障。**

### 15.2 已知限制

1. **服务等待上限 25s**（`IB_LAUNCH_SERVICES_TIMEOUT_MS`）：Bridge 永久故障时，UI 最多晚 25s 打开（P2 保持既有超时以免回归；P3/P5 可加启动画面或缩短）。
2. **boot-state 是"启动快照"，不是实时监控**：不轮询刷新；长时间不重启的会话里记录会自然变 `age` 陈旧。P5 若要实时状态，应自己探 `/health`，用 boot-state 解释"启动那一刻为什么这样"。
3. **复用旧静态服务时可能没有 `/__boot-state`**：P2 之前启动的 `internal-beyond-server.js` 实例会返回 404。P5 必须把 404 视为"契约不可用"（提示重启 IB），不要崩。
4. **VBS 层 fatal 无法写 boot-state**：找不到/无法运行 Node 时 JS 根本没跑起来；此时"记录缺失 + `logs\launcher.log` 里的 `[VBS] ERROR`"就是 runtime-fatal 的证据。
5. **无单实例保护**（P2 明确不做）：双击两次会并发启动，boot-state 以最后完成者为准（写入本身原子、不会损坏）。
6. **Vision 恒为 `not-enabled` / `probed:false`**：启动器不启动也不探测它；若将来 `--vision` 被纳入启动器，应把真实探测结果写入同一 `components.vision`。
7. **重启控制面是信息项**：`affectsOverall:false`，不可用不会让 overall 变 degraded。
8. **boot-state 写失败只在 `logs\launcher.log` 可见**（文件本身写不进去，无法自证）；P5 若需展示，可读日志尾部。
9. **静态服务仍以整个仓库根为静态根**（P2 未改，属发行层白名单问题）：发行包必须裁剪载荷。
10. **`%LOCALAPPDATA%` 依赖**：Windows 无 `LOCALAPPDATA` 时退到 `~/.internal-beyond`（与 runner 约定一致）。

### 15.3 明确未做（P2 范围外）

Diagnostics 页面、First-Run 向导、教程、Provider UI、API 错误产品化、Vision 安装器、Electron/Tauri/WebView2、单实例、日志路径统一、runner 重构 —— 全部留给后续阶段。
