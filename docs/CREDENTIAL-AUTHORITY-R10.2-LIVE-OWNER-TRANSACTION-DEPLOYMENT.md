# Credential Authority R10.2 Live Owner Transaction Deployment

日期：2026-09-22（Asia/Shanghai）

R0-R9：immutable baseline  
R10：BLOCKED before production write  
R10.1：PASS / workspace canonical writer established  
R10 Retry：BLOCKED before production write  
R10.2：**BLOCKED / DEGRADED before code and deployment**

本轮严格只执行 Installed Runtime Provenance Audit、Deployment Authority Audit 和 Active Transport/Auth Audit。没有修改代码、没有修改 installed `_up_`、没有停止或重启 Active、没有调用 transaction endpoint、没有读取 credential secret、没有调用 provider。

阻断条件已经满足 R10.2 stop rule：

1. 当前 live Active owner 使用 Tauri `_up_` resource tree，不是冻结的 canonical Inno production payload。
2. workspace 中的 R10.1 writer 尚未进入当前 installed payload。
3. Active 当前 HTTP surface 只有 loopback + Origin/CORS 约束，没有足够的 privileged authentication，也没有可复用的 target-scoped transaction command。

因此 R10.2 在实现 Narrow Transaction Command、部署、restart 和 live synthetic acceptance 之前停止。

## A. Scope

### 允许范围

- 只读确认 workspace 与 installed implementation 的差异。
- 只读确认 release manifest、Inno、update 和 lifecycle authority。
- 只读确认 Active listener、process ownership、现有 HTTP/IPC/auth surface。
- 形成 synthetic-only transaction 的后续 gate 结论。

### 本轮未执行

- 没有增加 `ACTIVE_METADATA_TRANSACTION` 或任何新 endpoint。
- 没有写入 `credentialRef`、`credentialAuthority`、`credentialSchemaVersion`。
- 没有调用 `credentialVault.get()`、Vault writer 或 provider/model。
- 没有直接 patch `active-message-service.json`。
- 没有 copy workspace JS 到 installed `_up_`。
- 没有 build、installer、running upgrade、restart 或 uninstall。

## B. Installed Runtime Provenance

### B1. Live process evidence

| Process | PID / PPID | Executable | Command line | Evidence |
|---|---:|---|---|---|
| Active | 13376 / 23928 | `[local path redacted]` | `...\_up_\services\active-message-service.js` | Win32 process query |
| Local services runner | 23928 / 21152 | `[local path redacted]` | `...\_up_\runtime\local-services-runner.js` | Win32 process query |
| Tauri host | 17168 / 13832 | `[local path redacted]` | installed host executable | Win32 process query |

PID 21152 在审计时已经不存在，因此无法从当前 process table 恢复更早的 parent command line。现有 source evidence 足以确认启动关系：

- `runtime/local-services-runner.js:143-152` 为 Active 定义 bundled `process.execPath` 与 installed-root-relative `services/active-message-service.js`。
- `runtime/local-services-runner.js:1189-1253` 由 runner spawn 并跟踪 Active child。
- `runtime/launch-internal-beyond.js:253-259` 以 `detached: true` 启动 runner。
- `启动 InternalBeyond.vbs:145-148` 通过同一 root 下的 `runtime\node\node.exe` 执行 `runtime\launch-internal-beyond.js`。

### B2. Live identity and binding

- Active listener：`127.0.0.1:23114`。
- Port owner：PID 13376。
- `GET /health`：HTTP 200。
- Health identity：`internal-beyond-active-messages`，service version `3`。
- Current installed root：`[local path redacted]`。
- Current boot-state launcher root：`[local path redacted]`，product version `1.0.6`，overall `normal`。

这证明当前 owner 是一个由安装版 Tauri host/runner 体系启动的、root-bound 的 live runtime；不是一个通过 workspace checkout 偶然启动的 Node 进程。

### B3. Runtime classification

当前运行实例不是 updater staging runtime：

- updater 的 payload 下载目录是 `%LOCALAPPDATA%\InternalBeyond\updates`，见 `runtime/update-install.js:41-45,103-109`。
- updater 下载的是 installer EXE，然后交给 Inno installer；它不会把 JS 直接放入 `_up_`，见 `runtime/update-install.js:9-18,874-890`。

当前实例也不是 fallback runtime 或 orphan runtime：

- Tauri host、Tauri uninstall executable、registry install location 和 boot-state root 都指向同一棵 `[local path redacted]`。
- 但该实例属于 **Tauri installed resource/acceptance runtime**，不属于 frozen canonical Inno production payload。P32-W.2B 明确将 Tauri `_up_` 定义为 acceptance bundle resource tree，而不是 canonical Inno payload（`docs/P32-W2B-RUNTIME-PAYLOAD-CLOSURE.md:96-110`；`docs/P32-W2-INSTALLER-AUTHORITY-CONVERGENCE.md:87-100`）。

## C. Workspace vs Installed Diff

只比较字节、结构 marker 和文件 metadata；没有读取 credential data。

| File | Workspace | Installed `_up_` | R10.1 result |
|---|---:|---:|---|
| `active/persistence.js` | 10,157 bytes；2026-09-22 18:02 | 5,042 bytes；2026-09-10 12:15 | structural hash differs；installed copy 没有 `mutateTargetMetadata` / `__r101_test_marker` |
| `services/active-message-service.js` | 29,593 bytes；2026-09-22 18:02 | 29,420 bytes；2026-09-20 08:05 | structural hash differs；installed copy 没有 R10.1 transaction export |
| `active/http.js` | 38,576 bytes | 38,576 bytes | byte-equal；仍然是旧的 Origin/CORS-only HTTP surface |
| `runtime/local-services-runner.js` | 84,657 bytes | 84,657 bytes | byte-equal |
| `runtime/launch-internal-beyond.js` | 27,143 bytes | 27,143 bytes | byte-equal |

Workspace R10.1 evidence：

- `active/persistence.js:122-171,242-249`：canonical synthetic writer、mutation chain、readback、rollback 和 export。
- `services/active-message-service.js:45-54,405-438,543-548`：R10.1 writer 接入 Active composition root 并导出 internal seam。
- `docs/CREDENTIAL-AUTHORITY-R10.1-ACTIVE-METADATA-TRANSACTION-WRITER.md:325-364`：R10.1 source/test gate PASS。

Installed verification：

- installed `active/persistence.js` 未包含 R10.1 marker/writer。
- installed `services/active-message-service.js` 未包含 R10.1 writer reference/export。
- installed root 没有 `ib-payload-manifest.json`，也没有 Inno payload 中的 `tools\ib-stop.js` 和 VBS 用户入口；这与 Tauri `_up_` resource tree 语义一致。
- source 与 installed `VERSION` 都是 `1.0.6`，但 workspace R10.1 文件时间晚于现有 `dist` 1.0.6 artifact（`dist/update-stable.json` 与 installer artifact 的时间为 2026-09-17）。版本相同不代表 payload bytes 相同。

## D. Deployment Authority

### D1. Canonical authority

canonical production route 已确认：

```text
root VERSION
  → scripts/release-manifest.js whitelist
  → scripts/build-installer.ps1 staging + audit
  → Inno installer/InternalBeyond.iss
  → canonical Inno install/upgrade root
  → bundled Node runtime + Active owner
```

证据：

- `docs/history/release/RELEASE_PIPELINE_AUDIT.md:27-98`：唯一版本源、唯一 canonical build command 和 9-step build contract。
- `scripts/release-manifest.js:6-22,43-79`：whitelist-only payload；`services/active-message-service.js` 与 `active/` 属于 canonical source manifest。
- `scripts/build-installer.ps1:361-420`：从 whitelist staging 生成 payload manifest；不消费 `_up_`、Tauri target 或 `.tauri-frontend`。
- `installer/InternalBeyond.iss:11-19,68-117,135-169`：Inno 是 installer authority，拥有 production AppId、payload copy、shortcut、upgrade/uninstall semantics。

### D2. Current installed authority mismatch

当前 `[local path redacted]` 的 registry evidence 是 Tauri NSIS identity：

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InternalBeyond` → `[local path redacted]`。
- Existing Inno production identity `{78B427F6-A48F-4443-86D5-2F50DC899D07}_is1` → 另一棵 `[local path redacted]`。

因此不能把当前 `_up_` 当作 canonical Inno payload 目录，也不能在该目录原位替换 R10.1 文件。R10.2 禁止的 “copy workspace JS → `_up_`” 与 “manually replacing installed runtime files” 均不允许。

### D3. Correct update path

正确的 installed payload 更新必须经过：

1. canonical source 进入 release manifest；
2. `scripts/build-installer.ps1` 生成 staging、audit、Inno EXE、checksum 和 stable manifest；
3. installer 或受支持的 updater 下载并校验 EXE；
4. `installer/InternalBeyond.iss:452-468` 在 `PrepareToInstall` 调用 root-scoped `ib-stop.js`；
5. Inno 替换 payload 并按 manifest 做 stale diff；
6. updater 只通过 `/IBRELAUNCH=1` 让 installer 重新启动 host（`installer/InternalBeyond.iss:264-273,161-169`）。

本阶段没有执行 build、发布、安装或升级；没有擅自 bump `VERSION`，也没有复用已有 1.0.6 artifact 作为新 payload 授权。

## E. Active Lifecycle Contract

Active registry/lifecycle evidence：

- `runtime/component-registry.js:243-264`：Active = `127.0.0.1` service on port `23114`，health `/health`，managed/restartable，cooperative stop `/__shutdown`。
- `runtime/local-services-runner.js:541-596`：runner 先走 cooperative stop，再做 root/identity-verified fallback；不会按 image name broad-kill。
- `runtime/service-control.js:23-45,51-83`：`/__shutdown` 是现有合作停止面，但该模块明确声明它**不是 authentication boundary**。
- `installer/InternalBeyond.iss:387-450`：canonical installer stop path 是 root-scoped `ib-stop.js`，并在替换 bundled Node 前等待 file unlock。
- `installer/tools/ib-stop.js:38-75,749-855`：root ownership、identity re-check、cooperative lifecycle 和 residual process gate。

### Restart authority decision

- production upgrade/uninstall：Inno `PrepareToInstall` / `[UninstallRun]` → `tools/ib-stop.js` → shared lifecycle。
- normal runtime restart：running runner 的 `/restart` control plane，见 `runtime/local-services-runner.js:1070-1095`。
- launcher：只负责启动/reuse runner 和 static server，见 `runtime/launch-internal-beyond.js:204-264`。

这些生命周期 surface 不是 R10.2 transaction authentication。由于本轮 auth gate 已失败，未调用任何 restart/stop surface。

## F. Existing Transport/Auth Audit

### F1. Active transport

- Active binds `127.0.0.1` and port `23114` (`services/active-message-service.js:25-32`).
- HTTP dispatch is in `active/http.js:156-184`。
- CORS admission is `active/http.js:90-104`：接受空 Origin、`null`、Tauri origin 和 localhost/127.0.0.1 HTTP origins。
- Allowed request headers are only `Content-Type` (`active/http.js:94-100`)。

### F2. Authentication result

在 `active/http.js` 中没有 incoming `Authorization`、Bearer、`X-IB-Token`、token-required、requestId、transactionId 或 operation allowlist implementation。该文件也没有 R10.2 command surface。

现有 routes 是普通 REST/state mutation routes，包括：

- `/credentials` → `credentialVault.upsert()` (`active/http.js:219-243`)；
- `/bg-ai`、tasks、plans、moments、reconcile、events、history mutation routes。

这些 routes 的 admission 仍是 Origin/CORS，而不是 privileged authentication。尤其 `/credentials` 不能被 R10.2 复用；本轮没有调用它，也没有读取或写入 Vault。

### F3. Existing control-plane auth is insufficient

- `runtime/service-control.js:30-42` 明确说明 `/__shutdown` 不是 auth boundary。
- `runtime/local-services-runner.js:910-939` 的 control-plane gate 是 Origin/CORS 规则。
- `runtime/local-services-runner.js:1070-1097` 的 `/shutdown` 与 `/restart` 没有 token-authenticated operation protocol。

结论：当前可以证明 loopback boundary，但不能证明 R10.2 要求的 existing privileged Active auth。不能依赖 “127.0.0.1 所以安全”，也不能在本阶段创建第二套认证系统或弱 endpoint。

### F4. Existing request identity / validation

| Requirement | Existing Active incoming surface |
|---|---|
| requestId / transactionId | 未发现 R10.2 可复用实现 |
| idempotency key | 未发现 Active metadata command；现有 economy `idempotencyKey` 仅属于另一个出站提案通道 |
| typed schema | 现有 REST 各自有业务 snapshot validation，但没有 synthetic transaction schema |
| operation allowlist | 没有 R10.2 operation allowlist |
| bounded readback | 没有 transaction readback route |
| rollback handle | 没有 transaction rollback route |

## G. Narrow Transaction Command

未实现。

R10.2 后续若继续，必须先拥有足够的 existing privileged auth，然后才能增加一个服务端固定 allowlist 的 typed operation：

- operation 只能是 synthetic metadata transaction；
- target 只能是现有 Active character target；
- field 只能是 `__r101_test_marker`；
- value 和 transactionId 必须有界；
- caller 不能提供 file path、object path、JSON pointer、arbitrary field、credentialRef、apiKey、secret 或 provider config；
- command 必须调用 R10.1 `mutateTargetMetadata()` / `rollbackTargetMetadata()`，不得自己读写文件。

本轮没有创建任何 command、endpoint、IPC message 或 frontend mutation path。

## H. Authentication Boundary

R10.2 authentication gate：**FAIL / BLOCKED**。

- loopback only：PASS。
- existing privileged Active auth：FAIL。
- missing auth reject：未建立新 command，不能宣称 PASS。
- malformed/wrong auth reject：未建立新 command，不能宣称 PASS。
- origin-only protection：明确不足。

Stop decision：不为了 R10.2 添加 temporary unauthenticated endpoint、debug backdoor、shell/fs/eval endpoint 或第二套 token authority。

## I. R10.1 Writer Integration

Workspace source/test 已证明 R10.1 writer 可用，但 live installed owner 未载入：

- workspace `active/persistence.js:122-171`：mutation chain、canonical `saveNow()`、readback、rollback。
- workspace `services/active-message-service.js:45-54,543-548`：internal-only writer export。
- installed copy：writer marker/reference absent。

因此：

- workspace R10.1 writer：PASS；
- installed R10.1 writer：FAIL / absent；
- live writer capability：FAIL / not loaded；
- external direct state patch：禁止且未发生。

## J. Canonical Packaging

Canonical source manifest 当前声明：

- `scripts/release-manifest.js:67`：`services/active-message-service.js`；
- `scripts/release-manifest.js:74`：`active/` directory closure；
- `scripts/release-manifest.js:62-79`：launcher、runner、services、Active modules、lifecycle modules。

这表示 R10.1 source 可以在下一次通过 canonical build/audit 的 payload resolution 中被纳入；不表示它已经进入现有 installed 1.0.6 bytes。现有 `dist/update-stable.json` 仍指向 `InternalBeyond-Setup-1.0.6.exe`，manifest 和 installer artifact 的 mtime 为 2026-09-17；R10.1 workspace file mtime 为 2026-09-22。

Canonical packaging authority 未改变：

- Tauri NSIS 没有被改成 production authority。
- root `VERSION` 没有被修改。
- Inno source、release manifest、installer/update contract 没有被修改。
- 没有直接复制 workspace 到 `_up_`。

## K. Installed Payload Verification

| Verification | Result |
|---|---|
| installed root identified | PASS: `[local path redacted]` |
| installed Active service identity | PASS: PID 13376 / health 200 |
| installed `active/persistence.js` contains R10.1 writer | FAIL |
| installed `services/active-message-service.js` exports R10.1 seam | FAIL |
| installed transport contains R10.2 command | FAIL / not implemented |
| workspace vs installed R10.1 source bytes equal | FAIL |
| direct installed patch | NOT DONE |

## L. Live Owner Verification

Live owner verification is only partial because the installed capability is absent:

- PID: 13376。
- command line: installed `_up_` Active service。
- health: 200。
- installed root: `_up_` resource tree。
- payload version: 1.0.6。
- R10.1 capability: absent。
- R10.2 transaction capability: absent。

A health response proves service identity and liveness only; it does not prove transaction capability and was not treated as an authorization channel.

## M. Synthetic Transaction

未执行。

没有写入 `__r101_test_marker`，没有创建 fake target，没有创建 production transaction record。

## N. Readback

未执行。没有 live transaction，因此没有 bounded readback response。

## O. Rollback

未执行。没有 live synthetic write，因此没有 production rollback handle 或 rollback operation。

R10.1 isolated writer rollback remains PASS；该结果不等价于 live installed rollback PASS。

## P. Contention

未执行 live contention acceptance。R10.1 的 contention test 使用 isolated Active composition root/data directory；本轮没有触发 scheduler action、provider request 或 runtime mutation。

## Q. Security Tests

R10.2 security test matrix 未执行，因为安全 transport 尚未存在。当前 audit 的静态结论如下：

| Check | Result |
|---|---|
| missing auth / wrong auth rejection for R10.2 command | BLOCKED: no command exists |
| non-loopback binding | PASS for current Active listener |
| unknown operation / arbitrary field / arbitrary object path | BLOCKED: no typed R10.2 command exists |
| credentialRef/apiKey rejection at live boundary | BLOCKED: no live boundary |
| oversized typed payload | BLOCKED: no R10.2 command |
| bounded readback/rollback | BLOCKED: no R10.2 command |
| secret-safe error/log contract | not exercised |
| provider call | 0 |

## R. Credential Invariance

R10.2 audit invariance：

- credentialRef writes：0。
- credentialAuthority writes：0。
- credentialSchemaVersion writes：0。
- apiKey deletion/overwrite：0。
- Vault writes/rewrite/cleanup：0。
- credential secret reads：0。
- provider/model calls：0。

只读取了 source text、process metadata、filesystem metadata、registry install metadata、health identity 和 non-secret boot-state projection；没有读取 credential-vault 或 Active state contents。

## S. Production Invariance

本轮保持：

- Active service 未停止、重启或 kill。
- `active-message-service.json` 未被直接或间接写入。
- Bridge/Home Node ownership 未改变。
- IndexedDB/localStorage 未写入。
- current installed `_up_` 未改变。
- production installer、stable manifest、VERSION 未改变。
- synthetic marker 未写入 live state。
- production business-data changes：0。

R10.2 本轮只新增本报告；没有新增代码或 test endpoint。

## T. Packaging Regression

本阶段在 canonical packaging audit 后触发 auth/live-owner stop，未运行 build/install regression。已完成的只读结论：

- Inno source remains the canonical production installer authority。
- Tauri `_up_` remains a separate acceptance/resource layout。
- VERSION authority remains the repository root `VERSION`。
- updater remains installer-mediated and does not write payload into `{app}` directly。
- shortcut/uninstall/lifecycle contracts were not modified。

未执行：fresh install、running upgrade、uninstall、payload hash reconciliation after a new build、P32-W regression suite、R5-R10 full rerun。既有 BOM baseline 未触碰。

## U. R10 Retry #2 Gate

| Gate | Result |
|---|---|
| 1. canonical deployment path identified | PASS |
| 2. R10.1 writer included in current installed payload | FAIL |
| 3. live installed owner loaded writer | FAIL |
| 4. safe authenticated transaction transport exists | FAIL |
| 5. loopback boundary verified | PASS |
| 6. operation allowlist verified | BLOCKED |
| 7. no arbitrary patch exposed by R10.2 | NOT IMPLEMENTED / no new endpoint |
| 8. credential fields rejected at live boundary | BLOCKED |
| 9. live synthetic write | NOT EXECUTED |
| 10. readback | NOT EXECUTED |
| 11. rollback | NOT EXECUTED |
| 12. no synthetic residue | PASS: none created by this phase |
| 13. live contention | NOT EXECUTED |
| 14. credential writes = 0 | PASS |
| 15. credential secret reads = 0 | PASS for this audit |
| 16. provider calls = 0 | PASS |
| 17. production business state semantically unchanged | PASS / read-only phase |
| 18. packaging invariance | NOT FULLY EXECUTED; no build/install occurred |
| 19. no new regression failures | NOT EXECUTED |

### Final summary

```text
Installed runtime source: Tauri installed resource tree [local path redacted]
Deployment authority: canonical Inno release/build/installer/update path
Writer included in installed payload: no
Live owner loaded writer: no
Transaction transport: Active loopback HTTP with Origin/CORS only; no R10.2 command
Authentication: no sufficient privileged incoming auth
Loopback only: yes
Arbitrary patch exposed by R10.2: no new endpoint; existing REST is not an acceptable transaction transport
Synthetic write: not executed
Readback: not executed
Rollback: not executed
Synthetic residue: none created
Credential writes: 0
Credential secret reads: 0 in this audit
Provider calls: 0
Unexpected business-data changes: 0
Packaging invariance: source contracts unchanged; full packaging regression not executed
R10 live-owner blocker: installed owner is old Tauri _up_ payload and lacks a safe authenticated transaction seam
R10.2 status: BLOCKED / DEGRADED before code and deployment
```

R10.2 完成后停止，不开始 R10 Retry #2、不开始 R11、不执行 credentialRef production write、不做 cleanup、Backup v2、Storage Convergence、Developer Mode、Jev 或 Android。不 commit，不 push。
