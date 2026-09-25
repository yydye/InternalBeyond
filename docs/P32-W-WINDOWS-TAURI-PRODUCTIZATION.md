# P32-W · Windows Tauri Productization & Acceptance

> Canonical closure report · 2026-09-21 · Windows x64

## A. Baseline

本轮范围是把 P32 的 Tauri 2 Host Foundation 推进到 Windows-first productization；本轮不进入 P33，不做 Android，不回滚或重写 P31/P32，也不修复既有 7 个 BOM baseline failure。

工作树在开始和收口时都保持 dirty；写入本报告前的收口检查为 `git status --short` 236 条状态行，当前 HEAD 为 `764a842`。本报告是随后新增的唯一 canonical closure artifact。既有 P31/P32 与更早阶段改动均被保留；没有执行 `reset --hard`、`checkout` 覆盖、`clean`、push 或 broad process kill。

现行入口和 authority：

```text
启动 InternalBeyond.vbs
  -> runtime/launch-internal-beyond.js
  -> runtime/local-services-runner.js
  -> existing Web Core / sidecars
```

- Browser fallback 仍是 `http://127.0.0.1:23120/InternalBeyond.html`。
- Tauri packaged app 使用 `tauri.localhost`/资源 origin；`runtime/host-origin.js` 保持 Tauri origin 与既有 HTTP/WS gates 的兼容。
- `assets/js/host-capability.js` 是唯一 Browser/Tauri capability switch；业务模块只访问 `IB.host`，接入点在 `InternalBeyond.html:3093-3094`。
- localStorage/IndexedDB 仍由 Web Core 持有，Home Node、Bridge、Active 和现有 storage authority 没有迁移到 Rust。Tauri WebView profile 与 Browser origin 的存储天然分开，这是本轮明确记录的 DEGRADED，不被伪装成“已有浏览器数据自动迁移”。
- 现有服务端口保持不变：static `23120`、Bridge `23115`、Active `23114`、Home Node `23118`、runner control `23116`。
- `%LOCALAPPDATA%\InternalBeyond\boot-state.json` 继续是 launcher/boot authority；Tauri 不创建第二套服务状态或版本来源。

本轮闭环判断：`DEGRADED`。Windows host、安装包、生命周期、资源安全、Browser fallback、sidecar connectivity 均已通过；真实 Astra A-D 因当前环境没有授权实网凭据而未执行，且完整 packaged DOM acceptance 尚未覆盖所有页面。因此不能把 Required closure gate 宣布为全绿；没有观察到产品代码级 FAIL。

P32-W.1 acceptance coverage note：此前的 “install acceptance PASS” 覆盖了安装、启动、boot-state、sidecar/resource closure，但没有覆盖安装后 WebView2 的视觉 DOM/CSS/network matrix。本轮首次复现了 packaged frontend 的无样式页面并完成资产解析审计；这是既有 acceptance coverage gap，不是 regression。

## B. Acceptance Matrix

状态只使用 `PASS`、`DEGRADED`、`FAIL`。`DEGRADED` 表示功能已有代码/回归证据但本轮没有完整的 packaged interactive coverage，或被当前环境能力阻断；没有把它改写成 PASS。

| Area | Windows acceptance | Evidence / boundary | Result |
|---|---|---|---|
| Core | launch、Web Core load、service connectivity | 最终 NSIS 安装后 host 启动；boot-state 为 `overall=normal`；23120/23115/23114/23118 healthy | PASS |
| Core | close、reload、single instance、window state | exact host close 后无 host 残留；second launch 不产生第二 host；窗口位置/尺寸恢复 | PASS |
| Core | navigation、theme、settings、sidebar、page switching | Browser regression 与 host 启动已验证；完整 packaged DOM walkthrough 未全量驱动 | DEGRADED |
| Core | packaged frontend asset/CSS/JS/font/background resolution (P32-W.1) | 修复前 `tauri.localhost/assets/...` 请求为 `500 text/plain`；修复后 135 JS、29 CSS 请求为 `200`，31 stylesheets/5241 rules，主题和背景资源生效；`game/tarot_bg.png` 是既有文档化缺口，单独排除 | PASS |
| Core | origin、localStorage、IndexedDB | Web Core 未迁移 authority；Tauri origin 与 Browser origin 存储隔离，现有 Browser 数据不会自动出现在新 profile | DEGRADED |
| Character | list、select、private chat、message persistence | Browser/chat contract smoke 通过；packaged UI 全量交互未独立驱动，且存储 origin split 仍存在 | DEGRADED |
| Character | image/file attachment、generated image、TTS、reasoning/model settings | 未观察到代码级失败；本轮未完成每项 packaged WebView2 交互矩阵 | DEGRADED |
| Group | group list/chat、multi-role、temporary mute、dynamic member、persistence | 既有 Web Core/contract 保持；packaged 全项交互未独立完成 | DEGRADED |
| Memory | UI、hydration、search、create/update、restart persistence | `test_memory_smoke.js` 的 Browser/authority/reload CRUD 通过；packaged UI walkthrough 未全量完成 | DEGRADED |
| Memory | Home Node connectivity | packaged boot-state 与 `23118/health` healthy；Home Node 仍是外部 authority | PASS |
| Middle Brain | runtime、reasoningEffort、config、trace、OOC、normal integration | `test_middle_brain_trace.js`、runtime integration、direct-channel contract 通过；测试 provider 为受控 mock | PASS |
| P31 Direct | hidden `?middlebrain` route、direct transcript、read-only boundary、close/return | P31 Browser smoke 与 `docs/P31_MIDDLE_BRAIN_DIRECT_CHANNEL.md` contract 通过；不写普通 chat/memory/activity stores | PASS |
| P31 Direct | packaged route / full DOM return flow | dev Tauri route 已工作；本轮未以 UI driver 完成所有 packaged DOM assertions | DEGRADED |
| P31 Direct | Astra real call、World Context、Project Knowledge、conflict authority | `--live` 预检因缺少授权环境变量安全退出，未发起请求；因此没有伪造 200 或答案 provenance | DEGRADED |
| Project Knowledge | dev search/read、authority、provenance、allowlist、path traversal | Browser/Tauri contract tests、Rust command compile/test、canonical/current/historical ranking 通过 | PASS |
| Project Knowledge | packaged resource root、index、README/VERSION、symlink/path safety | final install `_up_` 资源实际存在，索引 208 docs，README/VERSION 可读；native Rust re-checks canonical path | PASS |
| Activity | Cinema、Co-read、current Activity、clear、typing、context injection | existing Web Core 保留；P31 Direct namespace 不写 Activity；未全量 packaged walkthrough | DEGRADED |
| Social | Moments、Role Letters、Role DM、Diary、proactive message | existing authorities 保留；未全量 packaged walkthrough | DEGRADED |
| Economy | Economy UI、current state、commands、authority | Bridge/现有 Web authority 保留；未全量 packaged walkthrough | DEGRADED |
| Voice | microphone、ASR、TTS、autoplay、barge-in | KEEP_WEB；未在本轮改变权限/authority，未全量 packaged WebView2 实测 | DEGRADED |
| Vision / Image | upload、preview、native vision、generation、edit、Image Router | Vision 仍 optional/not-enabled；Image Router 未迁移；未全量 packaged walkthrough | DEGRADED |
| Misc | clipboard、download/export、backup/restore、file/folder picker、notifications | KEEP_WEB；host adapter 保留 fallback，未引入 unrestricted filesystem 或新 native plugin | DEGRADED |
| Misc | external URL policy | `https://` adapter path fulfilled；`mailto:`/`tel:` 明确 rejected；只允许 `http:`/`https:` | PASS |
| Browser | original HTTP entry and health | `http://127.0.0.1:23120/health` 返回 `ok=true`、`InternalBeyond Web`、version `1.0.6`；HTML 200 | PASS |

本矩阵没有 FAIL 行。不能全绿的原因是实网凭据和 packaged 全量 UI 覆盖不足，而不是为了隐藏失败而删项。

## C. Fixes

本轮只修复了会阻止 Windows 日常入口或产生 authority/lifecycle 风险的事项：

1. 在 `src-tauri/src/lib.rs` 接入 Tauri single-instance：第二次启动 focus/unminimize/show 现有窗口，不再创建第二个 IB host。
2. 接入 Tauri window-state：保存并恢复主窗口位置、尺寸、可见性、最大化等轻量状态，不写 Chat/Memory storage。
3. 让 Tauri host 复用现有 `runtime/launch-internal-beyond.js`，设置 `IB_LAUNCH_NO_OPEN=1` 和 `IB_TAURI_HOST=1`，避免 host 启动时再打开浏览器或另起一套 launcher 语义。
4. 退出时只对被本次 host 明确证明为 owned 的 runner/launcher 做 bounded shutdown；不按进程名杀 Node、WebView2、Chrome 或用户已有服务。
5. 开启 Windows NSIS bundle、current-user install、bundled WebView2 bootstrapper/resource closure，并用 `build.rs` 将 Cargo package version 与根 `VERSION` 锁定。
6. 修正 external capability 的 scheme boundary：`IB.host.external` 只接受 `http:`/`https:`，不允许 `mailto:`、`tel:` 或任意 shell scheme。
7. 将 Project Knowledge 作为第一个 native read-only capability 接入 Rust IPC，同时保留 Browser adapter 和既有 Web Core authority。
8. 修复 P32-W.1 的 packaged frontend URL root：`frontendDist` 改为单一 `.tauri-frontend` directory；`build.rs` 仅生成 HTML hard link 和 `assets`/`active`/`apps`/`game` directory junction，不复制第二套 frontend bytes，也不改 HTML/CSS/JS 路径。Tauri 官方配置语义见 [frontendDist reference](https://v2.tauri.app/reference/config/)。

没有因为“存在一个 Web API”就批量改成 native plugin；clipboard、notification、file picker、save/export、voice、vision 继续 KEEP_WEB。

## D. Host Lifecycle

启动合同为：

```text
HOST START
  -> detect/reuse healthy existing services
  -> launch existing launcher only when needed
  -> health/boot-state verification
  -> show Tauri window

HOST EXIT
  -> inspect boot-state ownership
  -> request runner / exact launcher shutdown only when host-owned
  -> leave external/shared services running
```

ownership：

| Component | Ownership | Port / behavior |
|---|---|---|
| Web/static | `SHARED` | 23120；可复用已有 healthy static，host close 不杀 |
| Home Node | `EXTERNAL_EXISTING` / shared authority | 23118；现有 launcher/runner authority，Tauri 不重写 |
| Bridge | `EXTERNAL_EXISTING` / shared authority | 23115；现有 auth/route authority 保留 |
| Active | `EXTERNAL_EXISTING` / shared authority | 23114；Tauri 不另起一份 |
| runner | `HOST_OWNED` only when this Tauri-invoked launcher reports `serviceManager.started=true`; otherwise external | control 23116；退出用 `/shutdown`，有 bounded wait |
| Vision | `OPTIONAL` | 不由 launcher 自动启动；boot-state 为 `not-enabled` |
| launcher child | `HOST_OWNED` while exact launcher is waiting | 仅记录 exact PID；fallback 也只操作 exact PID |

最终服务快照仍为 shared existing processes：runner `4792`、Bridge `19708`、Active `15764`、Home Node `31664`、static `18872`。它们在 host close 后继续 healthy，证明 Tauri 没有把用户原先运行的服务误判为自己的 child。

普通 close 就退出 host；本轮不加 tray，因为当前产品没有“关闭窗口但继续作为后台 Active Companion 运行”的明确要求。proactive/Active 继续由现有 sidecar authority 负责。

## E. Native Capabilities

真正 native 化的能力：

- Tauri host process 与 Windows window lifecycle。
- single-instance focus。
- window-state persistence。
- Project Knowledge 的只读 Rust index/search/read IPC；它需要 packaged resource root 的安全访问边界，且不应暴露 arbitrary filesystem。

保持 Web adapter 的能力：

- files、clipboard、notification、voice、vision、download/export、file/folder picker：当前没有证明 WebView2 必须 native 化。
- external open：继续走 `IB.host.external`，但先在 adapter 层限制为 `http`/`https`；没有加入 opener/shell capability。
- deep link、tray、updater：本轮不实现。

业务层没有直接调用 `window.__TAURI__`；Tauri invoke 只被 `assets/js/host-capability.js` 和 native host command surface 了解。

## F. Middle Brain

- Runtime Middle Brain、`reasoningEffort`、config、trace、OOC 与正常角色集成沿用已有 Web Core；`test_middle_brain_trace.js` 通过，side effects 被测试 contract 抑制。
- P31 Direct Channel 仍是 `InternalBeyond.html?middlebrain`，动态挂载独立 transcript，不创建普通导航页、不写 `chatMessages`、`activities`、`memories` 等普通 authority；关闭时保留原 hash/current page。
- Provider timeout policy 保持 120 秒（`assets/js/middle-brain-astra.js`）；timeout/network/provider errors 返回结构化错误，不留下无限 loading。
- World Context / Project Knowledge 的 retrieval/provenance seam 已存在，Project Knowledge authority ranking 为 `CANONICAL > CURRENT > HISTORICAL`；没有用 system prompt 硬编码测试答案。

真实 Astra：

```text
node tests/test_middle_brain_calibration_live.js --live --max-cases=1
```

在本环境安全预检为：`--live` 被显式要求，但缺少 `IB_CI_CALIBRATION_KEY` 与 `IB_CI_CALIBRATION_ENDPOINT`；没有发起网络请求、没有 silent mock fallback、没有伪造 HTTP 200。因此 Test A/B/C/D 结果为 `DEGRADED`，不是产品 FAIL。

## G. Project Knowledge

Browser 与 Tauri 共用同一个能力 contract：Browser 使用 `services/project-knowledge.js` fallback，Tauri 使用 `src-tauri/src/project_knowledge.rs` 的 native read-only commands：

```text
project_knowledge_status
project_knowledge_list
search_project_docs(query, limit, authority)
read_project_doc(docId, section)
```

资源与安全结果：

- final NSIS Add/Reinstall 资源根为 `[local path redacted]`；该 current-user install root 与源码/Browser dev server 分离。此前 `p32w-install-5` 仍保留为同轮旧 acceptance evidence；NSIS 因既有产品注册复用了现有安装位置，`p32w-install-6` 没有创建，报告不将其描述为已安装目录。
- 实际 resource tree 含 `docs` 208 个文件、根 `README.md`、`VERSION=1.0.6`；208 是当次 dirty source tree 的实际数，不是硬编码的 192，仍低于 `MAX_DOCS=512`。
- allowlist 为 docs 下 markdown/text 文档及允许的根级说明文本；拒绝 `.git`、node_modules、虚拟环境、credentials、`.env`、logs、数据库/backup/upload、browser-data、dist、target 等路径段。
- Rust 和 JS 都进行 canonical path boundary 检查、symlink rejection、1 MiB/file、8 search results、420-char snippet、32k read bounds；read 时再次 canonicalize 并检查 docId 对应文件未改变。
- `docId` 由稳定的 `project-doc:<relativePath>` 组成；结果带 `authority`、relative path/provenance，不把 arbitrary path 返回给 UI。

因此 packaged resource closure、allowlist 和 path safety 为 PASS。由 Astra 生成最终回答并证明 A-D provenance 的那一步，仍等待授权 live endpoint/key。

## H. Bundle

| Field | Value |
|---|---|
| Build command | `cargo tauri build --bundles nsis --no-sign --ci` |
| Artifact | Windows NSIS current-user installer |
| Path | `E:\InternalBeyond-main\src-tauri\target\release\bundle\nsis\InternalBeyond_1.0.6_x64-setup.exe` |
| Size | 89,873,254 bytes |
| SHA-256 | `69C4C8296909055C467628534CC82A6167303E60F8CFBE83D08251089BA87BF8` |
| Version | `1.0.6` |
| Authenticode | `NotSigned` |
| Release classification | `UNSIGNED DEVELOPMENT / TEST BUILD`, not a signed production release |

安装后的 host：

- `[local path redacted]`
- FileVersion/ProductVersion `1.0.6`
- size `37,148,160` bytes; SHA-256 `404F7B330E603CD9596D33703C5401C71E0D4553EBA3D356390A55814290E3D4`

Identity and version authority：

- canonical version source 是根 `VERSION`；`src-tauri/build.rs` 在 build time 拒绝 Cargo version drift。
- `productName=InternalBeyond`、`identifier=com.internalbeyond.desktop`、window title `InternalBeyond`、icon `src-tauri/icons/icon.ico`。
- Tauri NSIS 使用 `installMode=currentUser`、Start Menu folder `InternalBeyond`；WebView2 `downloadBootstrapper` 为 silent install mode。
- `%LOCALAPPDATA%\InternalBeyond` 仍由现有 launcher/boot-state 使用；Tauri WebView cache/profile 位于 `com.internalbeyond.desktop` 侧，和 Web Core domain storage 区分。

Update strategy 只做审计：当前 release authority 仍是现有 VBS/Node/Inno chain；Tauri updater 未实现。未来若引入 updater，应先确定签名、metadata、安装目录与 rollback ownership，再选择它是否替代现有 Inno/launcher；本轮不把两套自动更新混在一起。

## I. Install Acceptance

实际 NSIS Add/Reinstall 到独立于源码的 current-user root：

```text
[local path redacted]
```

验收链：

1. NSIS installer 完成 UI 显示 `Installation Complete / Setup was completed successfully / Completed`。
2. 从安装目录启动 host；最终 no-probe host PID `32604`，窗口标题 `InternalBeyond`，WebView2 child 正常出现；关闭后 exact PID 无残留。
3. 15 秒内 boot-state 为 `phase=complete`、`overall=normal`、`ok=true`，root 指向 installed `_up_`，Node source 为 `bundled`；static、Bridge、Active、Home Node 均 healthy，Vision 为明确的 `not-enabled` optional state。
4. 安装资源实际可读：208 docs、README、VERSION；没有把 dev source root 当成 packaged resource root。
5. 前一次同版本安装验收中，第二次启动返回 0、host count 保持 1，现有窗口 focus；移动到 `x=360,y=180,width=1100,height=700` 后 graceful close，再启动恢复同一位置/尺寸且不在屏外。最终 host close 后无 host process，shared service health 保持。
6. 关闭后没有改变现有用户数据 authority；但 Browser origin 与 packaged Tauri origin 的 localStorage/IndexedDB 不自动共享，见 A/B/O 的 DEGRADED 项。

P32-W.1 packaged asset-resolution evidence（probe-enabled acceptance build）：

| Probe | Before | After |
|---|---|---|
| `http://tauri.localhost/assets/css/core.css` | `500 text/plain` | `200 text/css` |
| `http://tauri.localhost/assets/js/core.js` | `500 text/plain` | `200 text/javascript` |
| `http://tauri.localhost/active/commerce.js` | `500 text/plain` | `200 text/javascript` |
| `http://tauri.localhost/game/game_module.js` | `500 text/plain` | `200 text/javascript` |
| `http://tauri.localhost/assets/images/bg-canvas.png` | `500 text/plain` | `200 image/png` |

Before probe 的 `href`/`baseURI` 为 `http://tauri.localhost/InternalBeyond.html`、origin 为 `http://tauri.localhost`，但 157 个候选请求全部是 `500 text/plain`，stylesheet rules 为 0。After probe 仍使用同一 `tauri.localhost/InternalBeyond.html` / origin / baseURI，135 个 JS 请求全部 `200 text/javascript`、29 个 CSS 请求全部 `200 text/css`，31 个 stylesheet 合计 5241 rules；`document.fonts.status=loaded`，没有本地 font URL/file。`bg-internal.jpg`、`bg-infernal.jpg`、`bg-canvas.png` 均成功加载，computed body 为主题背景 `rgb(24, 30, 50)`、颜色 `rgb(224, 230, 242)`、margin `0px`，anchor 为 styled block/padded control。最终 no-probe NSIS host 截图保留于 `[local path redacted]`。

`http://tauri.localhost/game/tarot_bg.png` 仍为 `500 text/plain`；该文件本来不存在，属于已有文档化 runtime asset gap，本轮不补素材、不改路径，也不把它归因给 CSS resolution fix。

本次 packaged CSS/DOM 复现与修复只闭合上述 asset-resolution layer；Core 的全页面导航、各业务域交互和完整 packaged DOM matrix 仍是 B 表中的 `DEGRADED`，没有因此宣布整个 matrix PASS。

Crash/failure UX：launcher/boot-state 保持现有 normal/degraded/fatal diagnostics；sidecar unavailable 时核心 host 仍可打开并暴露 degraded state，Vision 未启用是可解释状态；provider timeout 使用结构化错误。没有另写 Diagnostics UI。

## J. Browser Regression

Browser fallback 保持可用：

- `http://127.0.0.1:23120/health` 返回 HTTP 200，body 为 `ok=true`、server `InternalBeyond Web`、version `1.0.6`。
- `http://127.0.0.1:23120/InternalBeyond.html` 返回 HTTP 200，title 为 `Internal Beyond`，仍包含 `host-capability.js` 与 `middle-brain-direct.js`。
- Browser probe 仍解析 `http://127.0.0.1:23120/InternalBeyond.html`，origin/baseURI 保持 `http://127.0.0.1:23120`，CSS stylesheets rules 与主题 computed style 正常；Browser fallback 没有因为 packaged root fix 而改变。
- Browser adapter 继续使用静态 Web API/已有服务；Tauri adapter 只在 `__TAURI__.core.invoke` 存在时启用，不要求 Browser 安装 Tauri runtime。
- P31 Browser smoke 已验证 `?middlebrain#chat`、refresh restore、独立 Direct transcript、无 provider fail-safe、close 后恢复 `#chat`；P32-W 没有改变该 read-only boundary。

因此 P32-W 是 Browser/HomeNode adapter 与 Tauri adapter 共存，不是立即替换 Browser。

## K. Performance

最终 packaged host 的 Windows 观察值：

| Measurement | Observation |
|---|---|
| Cold start | host/window/boot ready 约 `2,134 ms` |
| Warm/second launch | second launch exits cleanly and focuses existing host；不创建第二套 runtime |
| Host working set | 原始值 `41,078,784` bytes，约 `39.2 MiB` |
| WebView2 child working set | 约 `115.4 MB` |
| Process count | host + 1 direct WebView2 child；sidecars 是已存在 shared processes |
| Leak check | exact close 后 host/WebView child 消失；23114/23115/23118/23120 shared health 保持 |

首次测量出现 host working-set `0` 的 stale/null sample，已剔除，不作为性能结论。没有发现 duplicate services、runaway process 或 leaked WebView；本轮不做大规模内存优化。

## L. Security

新增 Tauri capability 最小化：

```json
["core:default", "window-state:default"]
```

`src-tauri/capabilities/default.json` 没有 fs、shell、opener、notification、tray、updater 权限。Project Knowledge 由显式 Rust commands 提供，不能通过 command 读取 arbitrary filesystem；资源扫描和 read 都经过：

- allowlist extension/root/segment；
- canonical path must remain inside packaged root；
- symlink rejection；
- file/doc/result/read-size bounds；
- stable docId lookup rather than user-supplied path。

`IB.host.external` 只接受 `http:`、`https:`；`mailto:`、`tel:` 等被 `external-url-rejected` 拒绝。Host shutdown 不使用 `taskkill /IM`，只在 ownership 已由 boot-state 证明时请求 runner control 或操作 exact launcher PID。

## M. Tests

按 phase-specific unit/contract → host → packaged → targeted regression 执行：

| Command / acceptance | Result |
|---|---|
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | PASS |
| `cargo check --manifest-path src-tauri/Cargo.toml` | PASS |
| `cargo tauri dev` Windows launch / window responsiveness | PASS |
| `cargo tauri build --bundles nsis --no-sign --ci` | PASS |
| P32-W.1 pre-fix packaged runtime probe | COVERAGE GAP captured: `tauri.localhost/assets/...` returned `500 text/plain`; not a regression |
| P32-W.1 post-fix packaged runtime probe | PASS for frontend asset layer: CSS/JS/image URLs and computed theme verified; known `game/tarot_bg.png` gap excluded |
| `node tests/test_project_knowledge.js` | PASS |
| `node tests/test_runtime_integration_audit.js` | PASS |
| `node tests/test_middle_brain_direct.js` | PASS |
| `node tests/test_middle_brain_trace.js` | PASS |
| `node tests/test_boot_smoke.js` | PASS · 11 checks |
| `node tests/test_chat_smoke_provider_contract.js` | PASS |
| `node tests/test_memory_smoke.js` | PASS |
| `node scripts/scripts_check_html.js InternalBeyond.html` | PASS · 135 local scripts / 0 failed |
| `node tests/test_calibration_live_abort.js` | PASS · missing live credentials safely abort; no browser/network |
| `node tests/test_middle_brain_calibration_live.js --live --max-cases=1` | DEGRADED · explicit live preflight stopped because authorized key/endpoint absent; no request made |
| final NSIS Add/Reinstall/launch/boot/close/resource check | PASS · current-user root `[local path redacted]`; no fresh `p32w-install-6` because existing product registration was reused |
| final no-probe NSIS installer | PASS · `69C4C8296909055C467628534CC82A6167303E60F8CFBE83D08251089BA87BF8`, `NotSigned` |
| Browser health/HTML fallback check | PASS |
| 7 pre-existing BOM baseline failures | NOT P32-W; intentionally not modified |

既有 baseline BOM files：`assets/css/economy-shell.css`、`assets/js/autonomy-core.js`、`assets/js/communication.js`、`assets/js/economy-configuration-core.js`、`assets/js/economy-shell-core.js`、`assets/js/economy-shell.js`、`assets/js/home-node-client.js`。它们不被本报告重新归因给 P32-W。

## N. Resource Cleanup

本轮使用 exact PID/target cleanup，未使用 broad image kill：

- P32-W host test PIDs（包括 packaged cold/warm/window-state runs）：既有 `35552`、`32992`、`15976`、`2020`、`28292`，以及本轮 probe/install `1568`、`29360`、`32604`；installer/temporary exact process 也已退出。
- 当前 `internalbeyond-host.exe` / WebView child 无残留。
- 保留且未杀的 pre-existing shared services：runner `4792`、Bridge `19708`、Active `15764`、Home Node `31664`、static `18872`；23114/23115/23118/23120 health 仍为 true。
- 没有执行 `taskkill /IM node.exe /F`、`taskkill /IM msedgewebview2.exe /F`、`taskkill /IM chrome.exe /F`，没有触碰 DSH 或用户浏览器。
- `src-tauri/target` 与两个 isolated install evidence directories 保留为本轮构建/验收证据；target 已被 `.gitignore` 排除。
- `test_boot_smoke.js` 留下一个 test-owned temporary Chromium profile：`[local path redacted]`；这是测试 harness 的已知非失败提示，不是运行中的 IB service。

## O. Remaining

1. **实网 Astra A-D（Required gate）**：需要用户提供授权的 `IB_CI_CALIBRATION_KEY` 与 `IB_CI_CALIBRATION_ENDPOINT`，然后运行 `node tests/test_middle_brain_calibration_live.js --live --max-cases=4`，记录真实 200、World Context、Project Knowledge、historical-vs-canonical conflict 的 provenance。当前没有凭据，也没有伪造结果。
2. **完整 packaged DOM matrix**：P32-W.1 已闭合 CSS/JS/image asset-resolution，但仍需在安装后的 Tauri WebView2 中逐项驱动 Core、Character、Group、Memory、Activity、Social、Economy、Voice、Vision、Misc；当前 coverage-based `DEGRADED` 不得因为视觉恢复而升级为整套 PASS。
3. **Existing Browser storage visibility**：当前 Tauri origin 与 Browser origin 的 localStorage/IndexedDB 分开；若“现有浏览器数据必须在 Tauri 首次打开即可见”是硬要求，需要下一轮单独设计显式 export/import 或受控 migration。不要偷偷改变 Chat/Memory authority。
4. 可选 future work：代码签名、正式 updater、tray、deep link、native notification/clipboard/dialog；它们本轮都不是日常入口的必要 blocker。
5. **停止边界**：Android readiness 保持原状；本轮不执行 `tauri android init`、JDK/SDK/NDK/adb/APK，也不进入 P33。

P32-W 在这里停手：Tauri 已有可安装、可启动、可关闭、可恢复窗口状态且不破坏 Browser fallback 的 Windows host；剩余事项集中在授权 live provider 与更完整的 packaged interaction coverage，不扩张为 Rust/Web Core 或 sidecar authority migration。
