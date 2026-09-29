# P35 — Packaging Control Plane, Artifact Validator, Manifest Writer and Executor

状态：P35.0–4 已完成；**P35.5 Packaging Executor 已实现**。
边界：没有新的 Builder、UI 或发布步骤。所有构建仍只由现有 `scripts/build-installer.ps1` / Inno authority 负责；Release Builder 仍是独立 Release Orchestrator。

## 0. Phase 0 — Workspace Boundary

- Branch：`master`；HEAD：`ca98a4ea42a9aa90180d6c942d1da71d966a711c`。
- 本阶段开始前 `git status` 显示 **52 个 tracked 文件修改和 422 个 untracked 文件**（按 `--untracked-files=all` 计数，主要包含已有 `tmp/` 检查/编译现场、P34 报告和 Credential/Home Node/Tauri 工作）。
- 本轮只在 `tools/packaging-control-plane/` 新增 Validator、结果 Schema 与 synthetic tests，为 `scripts/release-audit.js` 增加兼容的 text-only release-claim adapter，并更新本架构文档和 `tests/test-all.js` 登记；没有覆盖、stash、reset、checkout、提交、push 或清理既有工作。
- P35.4 开始时仍在 `master` / `ca98a4ea42a9aa90180d6c942d1da71d966a711c`，已有的大量 Credential/Home Node/Tauri/P35/tmp 改动保持原状；基线为 53 个 tracked 修改、426 个 untracked 文件。本阶段新增 3 个 untracked 文件后，最终核对为 53 个 tracked 修改、429 个 untracked 文件。
- P35.4 只增加 Manifest Writer、相关 synthetic tests/schema 对齐和文档；没有改 Inno、build-installer、Release Builder、canonical payload manifest 或 Credential Authority。
- P35.5 在 `master` / `ca98a4ea42a9aa90180d6c942d1da71d966a711c` 开始，沿用 P35.4 末 53/429 的工作区基线；新增 `executor.js`、`owned-process.js`、`inspector-worker.js`、`tests/test_executor.js` 后最终为 53 个 tracked 修改、433 个 untracked 文件。
- P35.5 未覆盖、stash、reset、checkout、clean、删除既有 tmp、提交或 push；真实构建/安装/发布均未执行。

## 1. Current Authority Map

| Layer | Authority | P35 控制面边界 |
|---|---|---|
| Source | 当前 Git revision + 工作树内容 | 记录 revision/dirty；不改源码、不 bump version |
| Manifest | `scripts/release-manifest.js` | 只调用 `resolve()` 检查所需闭包；不调用 `stage()` |
| Audit | `scripts/release-audit.js` | canonical build 仍对 staged bytes 执行；P35.3 只在保留的 staging 上复用同一规则，不替代 build gate |
| Host staging | `scripts/stage-tauri-host.ps1` | 由 canonical installer pipeline 调用；Control Plane 不编译 Host |
| Installer | `installer/InternalBeyond.iss` via `scripts/build-installer.ps1` | **Existing Inno Setup = Production Installer Authority** |
| Orchestration | `tools/packaging-control-plane/executor.js` | 仅执行经核对的 BuildPlan delegate；不实现 staging/编译、不改变 authority |
| Validation | `scripts/build-installer.ps1` 的 identity/hash/version gates 与现有 installer tests/smokes | P35.3 独立复核最终 artifact 和固定 sidecar/staging 证据；不执行安装或 smoke |
| Tauri NSIS | Tauri CLI/build configuration | Acceptance / Validation only；不进入生产 installer authority |

目标生产链保持：

```text
Web Core / Source
        ↓
release-manifest
        ↓
release-audit
        ↓
Tauri Host staging
        ↓
runtime / service / resource closure
        ↓
scripts/build-installer.ps1
        ↓
installer/InternalBeyond.iss (Inno Setup)
        ↓
Windows Installer
```

### Existing Validation Capability Map

| Capability | Existing implementation / authority | P35.3 action |
|---|---|---|
| SHA-256 | `tools/release-builder/lib/verify.js:sha256File`; canonical build writes SHA256SUMS/update manifest | Reuse the Release Builder's streaming hash helper; compare the final bytes with both existing sidecars |
| Size bounds | `runtime/update-manifest.js` exports `MIN_PLAUSIBLE_INSTALLER_BYTES` / `MAX_PLAUSIBLE_INSTALLER_BYTES` | Reuse these bounds; add no new size magic numbers |
| Product version | `runtime/product-version.js` and `runtime/pe-version.js:matchesProductVersion`; `scripts/build-installer.ps1` already checks PE ProductVersion against VERSION | Reuse all three; unavailable PE metadata is WARN, a readable mismatch is FAIL |
| Filename / update metadata | `runtime/update-manifest.js:installerAssetName`, `parseInstallerUrl`, `validate`; Inno `OutputBaseFilename` in `installer/InternalBeyond.iss` | Reuse canonical name/manifest functions and read Inno's own macros for TestMode naming |
| Payload closure | `scripts/release-manifest.js:resolve/auditDirectory`; build-generated `ib-payload-manifest.json`; Inno compile `build-compile.log` | Reuse canonical resolver, manifest, compile log and `release-audit`; report missing/uncorroborated staging as WARN |
| Secret scan | `scripts/release-audit.js:SECRET_RULES`, `BINARY_MARKERS`, `scanDirectory` | Reuse existing secret vocabulary and scanner; do not copy patterns into a second scanner |
| User-data paths | `release-manifest.js:DENY_PATH` covers hidden files, logs, browser profiles and dev/test material | Extend only the Validator with a narrow deny check for Vault filenames, `.env`, SQLite/DB, chat/Memory exports, IndexedDB/AppData and `.ibvault` |
| Developer path leak | `release-audit.js` static `dev-path-win` / `dev-path-repo` markers | Reuse those results and add a dynamic scan for this checkout, profile and temp roots; report only path kind and match count |
| Build provenance | Release Builder SEAL `.log` / `.jsonl` includes commit and on-disk artifact/manifest equations; test build writes `installer-test-identity.json` | Read and cross-check these if present. Canonical build output has no signed source snapshot, so missing/unbound provenance is WARN, never inferred from current workspace |

## 2. Responsibility Boundary

### Existing Release Builder

`tools/release-builder` 保持 Release Orchestrator 身份：检查发行前提、编排阶段、调用 canonical build、校验结果并在独立确认后执行 publish。它不是任意目录打包工具，不负责 Backup、用户数据迁移或 Credential Export；P35 没有改它的流程或 UI。

### Packaging Control Plane

`tools/packaging-control-plane/` 提供 job contract、环境检查、deterministic build plan、只读 artifact validation、manifest serialization 和 P35.5 orchestration。只有 Executor 执行 Planner 描述的固定 canonical delegate；它不实现 staging/编译、不直接调用 ISCC、不修改 artifact、不安装或发布。

### Backup / Transfer

Backup / Transfer 是独立产品流程，不属于 Packaging。Job schema 不接受 credential、Vault、user data、Memory 或聊天数据字段。

## 3. PackagingJob Contract

JSON Schema：[`packaging-job.schema.json`](../../tools/packaging-control-plane/schemas/packaging-job.schema.json)。运行时校验在 [`contract.js`](../../tools/packaging-control-plane/contract.js)。

```json
{
  "id": "p35-release-1",
  "target": "windows-installer",
  "version": "",
  "channel": "stable",
  "mode": "release",
  "options": {
    "includeDocs": false,
    "includeExamples": false
  }
}
```

契约规则：

- 字段闭合：只接受 `id`、`target`、`version`、`channel`、`mode`、`options`；额外字段直接拒绝。
- `version: ""` 表示读仓库根 `VERSION`；显式版本必须与当前 canonical `VERSION` 一致。这个只读阶段不 bump 版本。
- `release` 只允许 `stable` channel；`debug` / `test` 只允许 `local` channel。
- `includeDocs`、`includeExamples` 目前只能为 `false`。Canonical pipeline 尚未实现可选内容切片；传 `true` 会失败关闭，不会被静默忽略。
- 递归拒绝规范化后匹配 `apiKey`、`credential`、`vault`、`userData`、`memory`、`chatHistory`、`IndexedDB`、`SQLite`、`AppData`、`secret`、`env` 等字段名；未知字段同样拒绝。

### Target 与 Mode

| 值 | Contract | 当前可执行计划 | 规则 |
|---|---|---|---|
| `windows-installer` | 支持 | **唯一 enabled target** | 委托已有 `scripts/build-installer.ps1` |
| `windows-portable` | 预留 | 否 | Planner 返回 `UNSUPPORTED`，不生成 build command |
| `web-export` | 预留 | 否 | Planner 返回 `UNSUPPORTED` |
| `android-apk` | 预留 | 否；未来扩展 | UI/调用方必须禁用；当前不报告构建能力 |
| `release` | 支持 | 是 | 委托 canonical production build；不包含 commit/push/tag/PUBLISH |
| `test` | 支持 | 是 | 只添加已有 `-TestMode`；使用 test-only identity 和独立 `tmp/installer-smoke-build`，不写 `dist` 或 Stable manifest |
| `debug` | 已定义 | 否 | 当前 Windows Installer 没有 debug artifact contract；Planner 返回 `UNSUPPORTED`，不回退到 release |

只有 `release` 且源码干净、Inspector 无 required `FAIL` 时，计划才标记 `releaseEligible: true`。脏工作区按要求产生 `WARN` 而非 Inspector `FAIL`；计划仍可预览，但不能标为 release-eligible。`test` 始终 `releaseEligible: false`。

## 4. Environment Inspector

实现：[`environment-inspector.js`](../../tools/packaging-control-plane/environment-inspector.js)。调用 `inspectEnvironment({ root, target, mode })` 返回：

```json
{
  "ready": true,
  "target": "windows-installer",
  "mode": "release",
  "repository": { "revision": "<git revision>", "dirty": true },
  "checks": [
    { "name": "cargo", "status": "PASS", "message": "Cargo version probe passed.", "required": true }
  ]
}
```

`ready` 只在 required checks 没有 `FAIL` 时为 true。`WARN` 包括 dirty worktree、可选 npm/Tauri CLI、未安装 WebView2 或尚不存在但父目录可写的 output 目录。消息只给摘要，不返回绝对路径、环境变量全集或 git status 文件名。

| 检查组 | 当前规则 |
|---|---|
| OS / Node | Windows target 要求 Windows；Node probe 检查运行 Control Plane 的 Node。另检查 pin 文件、`runtime/node/VERSION` 与 `runtime/node/node.exe` 存在；最终二进制 hash/version 仍由 canonical build gate 复核 |
| npm | 检查是否可用，但 root 无 `package.json`，当前 Inno 路径不依赖 npm；缺失为 WARN |
| Rust / Cargo | 必需；Tauri Host staging 使用锁定 Cargo build |
| Tauri CLI | 检查 `cargo-tauri` 是否存在；对 Inno production build 是可选项，只服务单独 Acceptance build |
| PowerShell / Inno | Windows PowerShell 5.1+ 与 Inno `ISCC.exe` 必需；Inspector 只定位/查询，不启动编译 |
| WebView2 | Registry 只读查询；未检测到时 WARN，因为 Inno 有独立 bootstrap policy，缺少它不妨碍编译安装器 |
| Required files/directories | 检查 build/Host/installer/license/runtime 文件及 Cargo `src`、`icons`、`capabilities` 目录；调用 canonical `release-manifest.resolve()` 看 payload closure，不调用 `stage()` |
| Version | 根 `VERSION`、Tauri Cargo package version、Node runtime pin/version 必须一致 |
| Repository | 只读获取 Git HEAD 与 porcelain dirty bit；dirty 是 WARN，不列出具体路径 |
| Storage | 检查 release/test output、OS temp、Host build root 的目录权限元数据和可用空间；默认 build free-space threshold 为 8 GiB，可通过 Inspector policy 参数调整 |

存储权限检查只调用 `stat` / `access(W_OK)`，**不创建或删除 probe file**。不存在的输出目录只检查最近已存在父目录，并报告 WARN。Git 子进程设置 `GIT_OPTIONAL_LOCKS=0`，避免可选 index 刷新；子进程环境采用必要路径变量白名单，不继承 API token、npm credential 等环境值。npm/Tauri CLI 只查找可执行文件，不运行它们。8 GiB 磁盘阈值仍是未由本轮真实 clean build 校准的 preflight policy；本阶段没有真实构建数据。

### 本机只读核对

本轮在当前工作区运行了 Inspector 和 dry-run Planner，没有执行计划中的步骤：

- `ready: true`；required toolchain、source closure、version、output/temp permission 和 free-space checks 为 PASS。
- 当前 `release-manifest.resolve()` 返回闭包完整（386 个文件），且不包含 `tools/packaging-control-plane/`；新控制面没有进入产品 payload。
- `git-cleanliness: WARN`，因为工作区已有改动；`host-build-writable: WARN`，目标目录尚不存在但最近父目录可写。
- Planner 为 `READY_WITH_WARNINGS`，`releaseEligible: false`（source dirty），`executes: false`，`publication: not-included`。

## 5. Build Planner

实现：[`build-planner.js`](../../tools/packaging-control-plane/build-planner.js)。`createBuildPlan(job, { root, inspection })` 的输出不含时间戳；`planId` 由标准化 job、revision、dirty bit 和稳定的检查名/状态摘要计算。

典型 Release 计划：

```json
{
  "schema": "internalbeyond.build-plan",
  "target": "windows-installer",
  "mode": "release",
  "status": "READY_WITH_WARNINGS",
  "executes": false,
  "publication": "not-included",
  "steps": [
    { "id": "environment-check", "type": "inspection", "status": "PASS" },
    { "id": "prepare-staging", "type": "delegated-substep", "owner": "scripts/build-installer.ps1" },
    { "id": "stage-tauri-host", "type": "delegated-substep", "owner": "scripts/build-installer.ps1" },
    { "id": "audit-staged-payload", "type": "delegated-substep", "owner": "scripts/build-installer.ps1" },
    { "id": "compile-inno-installer", "type": "delegated-substep", "owner": "scripts/build-installer.ps1" },
    { "id": "build-installer", "type": "delegate", "command": { "executable": "powershell.exe", "arguments": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/build-installer.ps1"] } },
    { "id": "validate-artifact", "type": "verification", "status": "PLANNED" }
  ]
}
```

`prepare-staging` 是 canonical installer pipeline 内部的委托步骤，Control Plane 不单独调用 staging 命令。`test` plan 只在同一个 command 里追加 `-TestMode`。Environment required check 失败时，所有后续步骤是 `BLOCKED`。Planner 永远只描述命令且 `executes:false`；P35.5 Executor 才能在校验过的 plan 上启动该 delegate。

## 6. Artifact Manifest Schema

Schema：[`artifact-manifest.schema.json`](../../tools/packaging-control-plane/schemas/artifact-manifest.schema.json)。P35.4 Writer 按此既有结构生成 sidecar；不与 canonical payload `release-manifest` 或客户端消费的 `update-stable.json` 混用。

```json
{
  "schema": "internalbeyond.artifact-manifest",
  "schemaVersion": 1,
  "product": "InternalBeyond",
  "target": "windows-installer",
  "version": "1.2.3",
  "revision": "<40- or 64-character git revision>",
  "sourceDirty": false,
  "mode": "release",
  "channel": "stable",
  "options": { "includeDocs": false, "includeExamples": false },
  "createdAt": "2026-09-28T00:00:00.000Z",
  "artifactFile": "InternalBeyond-Setup-1.2.3.exe",
  "artifactBytes": 52000000,
  "hash": "<64 lowercase sha256 hex>",
  "validated": true,
  "validation": { "status": "PASS", "checks": [{ "id": "request-contract", "status": "PASS" }] }
}
```

Schema 使用 `additionalProperties: false`，不允许 secret、Vault、用户数据、绝对路径或未注册字段。`artifactFile` 限定为单一文件名，不接收绝对路径或目录 traversal；`validated: true` 要求 validation status 为 PASS。revision pattern 向后兼容地接受 Git SHA-1 / SHA-256 revision。`createdAt` 由调用方显式传入，Writer 不读取时钟。它与 payload `release-manifest` 及客户端消费的 `update-stable.json` 是三种不同 authority。

## 7. Artifact Validator

### 7.1 Purpose

The Validator accepts a final Windows Installer artifact and returns a deterministic ValidationResult. It does not call a builder, install an artifact, fix metadata, write a sidecar, publish, sign, or upload.

### 7.2 Authority Boundary

| Operation | Allowed |
|---|---|
| inspect, read, measure, hash, compare, report, reject | Yes |
| modify, repair, rewrite, repack, restage, rebuild, install | No |
| sign, publish, upload, write artifact manifest | No |

### 7.3 Input Contract

The request is separate from PackagingJob so an artifact path never enters the build-options contract:

    {
      "job": {
        "id": "p35-validation-1",
        "target": "windows-installer",
        "version": "1.2.3",
        "channel": "stable",
        "mode": "release",
        "options": {}
      },
      "artifact": { "path": "dist/InternalBeyond-Setup-1.2.3.exe" },
      "buildContext": { "revision": "<git revision>", "dirty": false }
    }

Only release and test modes are accepted for this target. Build context is caller-provided build-time evidence; the Validator records it and never substitutes current workspace state.

### 7.4 Path Boundary

The accepted artifact path must exactly match the canonical filename under dist for release or tmp/installer-smoke-build for test. Absolute, UNC, network, path traversal, arbitrary directories, symbolic links, junction/reparse points, and hard-linked artifact files are rejected before reading artifact bytes. Sidecars and staging are resolved from those same fixed output roots; the request cannot supply alternate sidecar or staging paths.

### 7.5 Validation Layers

| Layer | Check |
|---|---|
| Artifact identity | Exists, regular file, canonical .exe name, canonical size bounds, recomputed lowercase SHA-256 |
| Version | PackagingJob versus root VERSION; canonical update manifest or TestMode identity sidecar; PE ProductVersion and fixed ProductVersion/FileVersion via the existing PE parser |
| Payload closure | Safe inventory of retained staging; generated payload manifest equals physical files; compare against release-manifest whitelist when the recorded clean revision still matches the current clean checkout; compare the Inno Compressing list with staged files; always reject P35 Control Plane, tests, tmp, logs and reports paths |
| Secret / user data | Reuse release-audit secret patterns and binary markers; add narrow path rules for Vault files, .env, SQLite/DB, IndexedDB/AppData, chat/Memory exports and .ibvault |
| Developer path | Reuse existing release-audit path rules and scan staged text for the current repository, profile and temp roots; report only path kind and match count |
| Release policy | Record build-time revision/dirty; when present, cross-check Release Builder SEAL log header, artifact SHA/size equations and git cleanliness items |

The Validator does not parse the compressed Inno container. Its payload evidence comes from retained canonical staging, its payload manifest, release-audit, and the Inno compile log.

### 7.6 ValidationResult

Schema: tools/packaging-control-plane/schemas/validation-result.schema.json.

Check statuses are PASS, WARN, or FAIL. Overall aggregation is:

- Any FAIL gives overall FAIL.
- No FAIL plus one or more WARN gives PASS_WITH_WARNINGS.
- All checks PASS gives PASS.

The result sets valid=true only for full PASS. It contains the artifact basename/size/SHA, target/version/mode, the supplied build revision/dirty bit, stable checks, and summary counts. It has no timestamp, random ID, absolute path, secret excerpt, or raw finding path.

### 7.7 Failure Semantics

The Validator emits specific codes, including INVALID_REQUEST, ARTIFACT_NOT_FOUND, ARTIFACT_OUTSIDE_ALLOWED_ROOT, ARTIFACT_HASH_FAILED, VERSION_MISMATCH, VERSION_METADATA_UNAVAILABLE, BUILD_METADATA_MISMATCH, PAYLOAD_VALIDATION_FAILED, SECRET_DETECTED, USER_DATA_DETECTED, PATH_LEAK_DETECTED, PROVENANCE_INCOMPLETE, and VALIDATION_INTERNAL_ERROR.

Unavailable metadata is WARN and never a fabricated PASS. Readable mismatches, unsafe paths, forbidden files, secrets, and closure disagreements are FAIL. No failure path repairs or deletes data.

### 7.8 Security Rules

- No user AppData, Vault, IndexedDB, Home Node database, chat, Memory, WebView profile, or backup path is scanned outside the fixed artifact/staging roots.
- Secret findings are represented by rule/count only; release-audit excerpts and matching values are discarded.
- A harmless field label such as apiKey is not a secret by itself; existing assignment/value patterns remain the secret authority.
- The Validator reads only the final artifact, fixed build sidecars, canonical source metadata, and staging when present.

### 7.9 Provenance and Manifest Writer Boundary

Release Builder SEAL logs are checked against the final artifact hash/size and three-way manifest equations even when caller build context is absent. A supplied build-time revision/dirty snapshot is cross-checked against the log; current workspace state is never substituted. TestMode identity sidecars bind the test artifact bytes but do not record source revision. Direct canonical builds do not create a signed source snapshot. Missing or unbound provenance therefore returns PROVENANCE_INCOMPLETE WARN.

P35.4 Manifest Writer 只接受该模块原样签发且未被修改的 ValidationResult；Validator 的 issuance marker 是进程内状态，不是签名或跨进程 attestation。PASS_WITH_WARNINGS / FAIL 均直接拒绝，不提供人工 override。

## 8. Security Rules

- Contract 只收固定 enum / bool / semver / job id；不接受 path、glob、command、credential 或用户数据字段。
- Secret scan 复用现有 `release-audit.js` staged-byte scanner；Validator 不复制 secret vocabulary，且不把单独的 API key 字段名判为 secret。
- User data scan 拒绝 IndexedDB 导出、SQLite/Home Node 用户数据库、聊天、Memory、AppData、WebView profile 与 Recovery 现场；只检查固定 artifact/staging root。
- Path leak scan 检查当前 checkout、用户 profile 和 temp roots；结果只给 `pathKind` 与 `matchCount`，不输出匹配路径或原文。
- Backup / Transfer 的加密导出、预览和用户确认不得复用 Packaging job/options。

Inspector 不读取 Vault 或用户数据库，也不做内容 secret scan；内容安全由 Validator 对 staging 复用 canonical staged-byte audit。

## 9. Provenance Limitations

1. 默认 canonical build 会清理 staging；staging 不存在时，payload closure 与内容扫描返回 WARN，不能形成全 PASS。
2. Release Builder SEAL log 可把 commit 与 artifact digest/equations 对上，但它是本地未签名文件，不是不可伪造的 build attestation。
3. Test identity sidecar绑定 test artifact hash，不包含 source revision/dirty snapshot；test mode 会报告 `PROVENANCE_INCOMPLETE`。
4. Direct PowerShell build没有 artifact-bound source revision/dirty snapshot。Validator 记录 caller 提供的 buildContext，不从当前 worktree 伪造历史状态。
5. Inno setup 使用压缩 payload；Validator 不解析该二进制容器，依赖保留 staging、payload manifest、release-audit 与 Inno compile log 建证据链。

## 10. Non-Goals

P35 不负责构建、安装、修复、签名、发布、上传或替换 artifact。Manifest Writer 不能把 `PASS_WITH_WARNINGS` 转成 `WARN` manifest，也不能请求人工 override；只有完整 PASS 可以写 `validated: true`。

Validator 不会成为 Builder、Repair Tool、Installer、Signer 或 Publisher。

## 11. Future UI — Design Only

本轮没有 UI。后续 Packaging Center 可按以下只读到执行的阶段展示：

```text
Target
  → Environment Check
  → Build Plan
  → Execute (P35.5 backend; no UI)
  → Artifact Validator
  → ValidationResult
  → Artifact Manifest Writer (P35.4, implemented)
```

当前唯一 enabled target 是 Windows Installer；Portable/Web/Android 只能作为禁用说明，不出现可点击 Build。Release Builder 仍是发行操作工具，P35 UI 不替换其发行/publish 流程。

## 12. Tests

新增定向纯 Node 测试，fixture 均为 fake/synthetic，写入系统临时目录并由各测试清理；本轮不使用真实 artifact 或凭据：

| Suite | 覆盖 |
|---|---|
| `test_contract.js` | target/mode/channel、默认 options、未知/禁止字段、schema closed-world 属性、canonical version |
| `test_environment_inspector.js` | PASS/WARN/FAIL、dirty WARN、缺 Cargo、空间不足、缺 payload closure、不可写目录、无探针写入 |
| `test_build_planner.js` | deterministic plan、release 与 `-TestMode` 路由、未来 target/debug blocked、dirty release-ineligible、required FAIL 阻断、无 publish/执行/绝对路径 |
| `test_artifact_validator.js` | artifact identity/hash/size、version match/mismatch/unavailable、metadata/provenance mismatch、payload closure、secret/user-data/path leak、output-root escape/junction、aggregation、determinism、无 manifest write |
| `test_manifest_writer.js` | PASS gate / forgery / completeness、manifest schema、deterministic serialization、sidecar path boundary、atomic write/read-back、identical no-op、conflict、不读写 artifact |
| `test_executor.js` | preflight/plan hard gates、canonical delegate arguments、exit/artifact/validation/manifest failures、state transitions、cancellation races、PID/start-time/parent ownership、single-flight 与 final identity confirmation |

运行方式：

```powershell
node tools\packaging-control-plane\tests\test_contract.js
node tools\packaging-control-plane\tests\test_environment_inspector.js
node tools\packaging-control-plane\tests\test_build_planner.js
node tools\packaging-control-plane\tests\test_artifact_validator.js
node tools\packaging-control-plane\tests\test_manifest_writer.js
node tools\packaging-control-plane\tests\test_executor.js
```

测试只检查 fake installer bytes 和 synthetic staging；不调用 `scripts/build-installer.ps1`、ISCC、安装器、PUBLISH 或 Tauri build。

## 13. Risks

1. 8 GiB 是未实测的初始 free-space threshold；下一阶段应用真实 clean build 测量校准。
2. `access(W_OK)` 是无写入权限的近似探测，不能保证后续创建必然成功；P35.5 不把该结果当作任意路径写入授权，staging/Host build 目录仍由 canonical script 的 ownership marker 管理。
3. Windows WebView2 Registry 只读查询失败时显示 WARN；真正的 install/launch 结论必须在隔离 smoke 中得出。
4. Windows Installer Release 计划在 dirty worktree 上可预览，但 `releaseEligible` 为 false；发布仍受既有 Release Builder 和 canonical release checks 限制。
5. `debug`、Portable、Web Export、Android 都没有 executable plan；UI 不得把 enum 存在等同于功能可用。

## 14. Files Changed

- P35.3 新增 `tools/packaging-control-plane/artifact-validator.js`、`schemas/validation-result.schema.json` 和 `tests/artifact-fixture.js` / `tests/test_artifact_validator.js`；`scripts/release-audit.js` 增加兼容的 text-only release-claim adapter。
- P35.4 新增 `artifact-manifest-writer.js`、`schemas/artifact-manifest-write-result.schema.json` / `tests/test_manifest_writer.js`；修改 `artifact-validator.js` 加入非序列化 issuance guard，`artifact-manifest.schema.json` 接受 SHA-1/SHA-256 Git revision。
- P35.5 新增 `executor.js`、`owned-process.js`、`inspector-worker.js` 和 `tests/test_executor.js`；复用 Inspector 环境白名单，增加 artifact identity measurement helper，并注册 Executor API / 定向测试。
- P35.5 未改 `scripts/build-installer.ps1`、`scripts/stage-tauri-host.ps1`、`installer/InternalBeyond.iss`、`tools/release-builder` 或 Credential Authority。

## 15. Next Phase Recommendation

P35.5 已完成并停止。任何 Packaging Center UI 或 durable job recovery 都应由独立阶段明确授权；Portable、Web Export、Android、自动签名和自动发布仍未实现。

## 16. P35.4 Artifact Manifest Writer

### 16.1 Purpose and Manifest Ecosystem

实现：[`artifact-manifest-writer.js`](../../tools/packaging-control-plane/artifact-manifest-writer.js)。它序列化某次已验证构建产物的 identity、source provenance 和验证状态。

| Manifest | Authority / meaning | Writer relationship |
|---|---|---|
| `release-manifest.js` result | Canonical Windows payload closure | 不读写或改写该清单 |
| `dist/update-stable.json` | 客户端 update contract 与 Stable 发布 metadata | 不覆盖；sidecar 用独立名称 |
| P35 Artifact Manifest | 单次构建 artifact 的 identity/provenance/validation evidence | 本阶段唯一写入对象 |

因此 `Artifact Manifest != release-manifest != update-stable.json`。

### 16.2 Authority Boundary

Writer 允许接收 Validator evidence、规范化 job/provenance、序列化、按冻结 schema 校验、写 sidecar、read-back、compare 和 report。它不构建、修改或读取 artifact bytes，不修复、不独立复验、不发布、不上传、不签名，也不触碰 Inno/build authority。

依赖方向保持 `Manifest Writer → Artifact Validator → release-audit reusable primitive`。`scripts/release-audit.js` 不依赖或导入 Packaging Control Plane。

### 16.3 Gate Contract

只有未修改、由 P35.3 Validator 在当前进程签发的 ValidationResult，且 `status === "PASS"`、`valid === true`、summary 与完整必需 checks 一致时才继续。Writer 同时校验 ValidationResult schema 和语义闭合；JSON clone、缺字段、重复 check、summary 不一致或结果被修改均拒绝。`PASS_WITH_WARNINGS`、`FAIL` 和 `PASS + valid:false` 不写 sidecar。

进程内 issuance marker 防止普通调用方构造形状相似的 JSON，但它不是密码学签名；跨进程/远程调用需要未来独立设计的认证证据，本阶段不实现。Validator 的 adapter overrides 只供 synthetic tests；正式调用使用默认实现。

### 16.4 Manifest Input

最小请求：

```json
{
  "job": { "id": "p35-manifest-1", "target": "windows-installer", "version": "1.2.3", "channel": "stable", "mode": "release", "options": {} },
  "validationResult": "P35.3 Validator 返回的原对象",
  "provenance": { "createdAt": "2026-09-28T05:00:00.000Z" }
}
```

请求不接收 artifact path、output path 或 `validated`。Job 经现有 `contract.js` 校验并与 ValidationResult target/version/mode 对齐；revision 与 dirty 只从 ValidationResult context 派生。为保留既有 schema 的 `createdAt` 字段，调用方必须显式提供 canonical UTC 时间，Writer 不调用 `Date.now()`。模块的第二参数 `root/io` 仅供隔离测试注入；普通请求中没有路径或 I/O adapter 字段。

### 16.5 Manifest Projection and Schema

字段顺序和形状保持既有 `artifact-manifest.schema.json`。Artifact `name/size/sha256` 直接来自 ValidationResult；`revision/sourceDirty/target/version/mode` 来自其 context；channel/options 来自匹配的 PackagingJob；`validated:true` 与 validation `PASS` 由 gate 派生。Validation checks 只投影 `{id,status}`，不复制 message、evidence、secret finding、完整日志或环境信息。Writer 自带只覆盖冻结 P35 JSON Schema 所需关键词的无依赖校验器，不访问网络或 `$ref`。

### 16.6 Provenance Rules

Writer 不运行 `git rev-parse` / `git status`，不使用当前 workspace 补写历史来源，也不接收调用方覆盖 revision/dirty。只有 ValidationResult 已提供完整且 clean 的 build-time provenance、并达到完整 PASS，manifest 才可写。createdAt 是明确的序列化输入，不充当 build provenance。

### 16.7 Deterministic Serialization

`buildArtifactManifest(request)` 是纯投影 API：稳定字段顺序、2 空格 JSON、UTF-8、LF 和单一 trailing newline；hash 为 sidecar 序列化字节的 lowercase SHA-256，只返回在 WriterResult，不写入 manifest 自身。相同 job、原 ValidationResult 与 provenance 会得到相同 manifest 字节。

### 16.8 Sidecar Name and Output Boundary

sidecar 命名为 `<artifactFile>.manifest.json`，例如 `InternalBeyond-Setup-1.2.3.exe.manifest.json`。release 从固定 `dist/` 推导目录，test 从固定 `tmp/installer-smoke-build/` 推导；artifact 与 sidecar 同目录。请求不能指定任意目录，output root 与目标文件的 symlink/reparse/hard-link 情况失败关闭。Writer 不创建 output directory。

### 16.9 Atomic Write and Read-back

Writer 创建同目录独占临时文件，flush/fsync 并 close；随后重新读取临时文件、解析 JSON、校验 schema 和 canonical 内容，再通过同目录 `linkSync(temp, final)` 原子地创建 final 名称，拒绝替换已存在目标，移除本次创建的临时文件，最后再读取 final 并验证 schema 与内容。该无覆盖 hard-link 提交用于避免 `rename` 在部分平台替换既有文件；不支持同卷 hard-link 的文件系统会返回 `MANIFEST_WRITE_FAILED`，不会回退成可覆盖写入。Windows 目录项断电持久化不由本 API 保证。最终 read-back 失败时返回 FAILED；已原子提交的 sidecar 留给人工检查，不会自动删除或重写。

### 16.10 Existing Manifest Policy

- 不存在：完成原子写入，返回 `WRITTEN`。
- 已有字节与确定性输出逐字节相同：不写入，返回 `ALREADY_IDENTICAL`。
- 已存在其他内容：返回 `MANIFEST_ALREADY_EXISTS_CONFLICT`，原文件不变。
- 临时文件名已被占用：返回失败，不删除未知临时文件。

### 16.11 WriterResult and Failure Codes

WriterResult Schema：[`artifact-manifest-write-result.schema.json`](../../tools/packaging-control-plane/schemas/artifact-manifest-write-result.schema.json)。状态冻结为 `WRITTEN`、`ALREADY_IDENTICAL`、`DENIED`、`FAILED`，携带稳定 code、静态摘要和 sidecar basename/hash；不返回绝对路径或输入原文。代码区分 `INVALID_REQUEST`、`VALIDATION_RESULT_INVALID`、`VALIDATION_NOT_PASS`、`MANIFEST_SCHEMA_INVALID`、`OUTPUT_PATH_INVALID`、`MANIFEST_ALREADY_EXISTS_CONFLICT`、`MANIFEST_WRITE_FAILED`、`MANIFEST_READBACK_FAILED`、`MANIFEST_CONTENT_MISMATCH` 和 `FORBIDDEN_FIELD_DETECTED`。

### 16.12 Security Rules

Job 使用既有闭合 contract；provenance 只收显式时间字段；未知 secret/user-data 字段拒绝。Manifest 不接收或保存 API key、Vault/user data、absolute developer path、完整 ValidationResult findings、build log 或 environment dump。sidecar 输出目录只从固定 mode root 推导。

### 16.13 TOCTOU Invariant

Manifest 的 artifact identity 完全取自 ValidationResult。**Validated artifact bytes are immutable between validation and manifest emission.** Writer 不重读/重算 artifact hash；未来 Executor 必须保证 Validator PASS 到 Manifest Writer 之间 artifact 不被替换。本阶段不增加 descriptor handle 或 hash recheck gate。

### 16.14 Non-Goals and Next Phase

P35.4 不实现 UI、Executor、Portable/Web/Android、签名、发布或 upload。当前 test-mode ValidationResult 会因 provenance WARN 被 gate 拒绝。后续阶段可独立评估 UI 或调用流程，但不能绕过 PASS gate。

### 16.15 P35.4 Files and Tests

新增 `artifact-manifest-writer.js` 与 `tests/test_manifest_writer.js`，导出 `buildArtifactManifest()` / `writeArtifactManifest()` 并从 `index.js` 汇出。`artifact-validator.js` 增加不序列化的 issuance marker，防止普通对象或修改后的结果冒充；Artifact Manifest revision pattern 与 Validator 的 40/64 位 Git revision 对齐。所有写入测试只使用 P35 synthetic fixture。

## 17. P35.5 Packaging Executor

### 17.1 Purpose and Authority

实现：[`executor.js`](../../tools/packaging-control-plane/executor.js)。它把 Contract、Inspector、Planner、Validator 和 Manifest Writer 串起来，并且只执行 BuildPlan 中固定的 `scripts/build-installer.ps1` delegate。

Executor 可以 preflight、生成/核对 plan、启动该 delegate、跟踪它所拥有的进程、定位预期 artifact、冻结 identity、调用 Validator/Writer、报告 state 和取消当前 job。它不 staging、不调用 ISCC、不修复或改写 artifact、不改 Installer authority、不发布/上传/签名。

### 17.2 Canonical Build Delegation Map

| 问题 | 当前 authority / 行为 | Executor 行为 |
|---|---|---|
| `scripts/build-installer.ps1` 输入 | release 无必需参数；test 只加 `-TestMode`。脚本还有 `-IsccPath`、`-KeepStaging`、`-SkipAudit`、`-InstallAudit` 等选项 | 严格执行 Planner 产生的固定参数数组；不接收任意参数，也不传 `-SkipAudit`、`-KeepStaging` 或 `-InstallAudit` |
| Release Builder 调用 | `tools/release-builder/lib/build.js` 用 `canonicalBuildArgs()` + `lib/env.spawnStream()`，`shell:false`，默认 timeout 60 分钟；还会在 build 前 bump VERSION/README 并 journal rollback | 不运行 Release Builder 整体，也不做版本 bump；只委托相同 canonical build script |
| 环境变量 | build 用 `PATH/PATHEXT`、`PSModulePath`、SystemRoot、ProgramData/ProgramFiles/LOCALAPPDATA、USERPROFILE、TEMP/TMP、CARGO_HOME/RUSTUP_HOME 等 | 复用 Inspector 的环境白名单；不传 API key、Vault token 或完整环境 dump |
| 输出目录和 artifact | release: `dist/InternalBeyond-Setup-<version>.exe`；test: `tmp/installer-smoke-build/InternalBeyond-Installer-Smoke-Test-Setup-<version>.exe` | 从 BuildPlan mode/outputRoot 和 Validator 的 canonical Inno naming helper 推导；不扫描磁盘，也不接受 path 参数 |
| exit / logs | 成功 exit 0；脚本失败为非零。ISCC console 输出写到固定 output root 的 `build-compile.log`；脚本生成 hash/update metadata | 非零、signal、spawn failure 都停止后续阶段。stdout/stderr 只 drain，不保留原文；Result 仅留 exitCode 与结构化事件 |
| 子进程 | Preflight 的固定 `inspector-worker.js` 调用只读 Inspector；build 的 PowerShell 会调用 bundled Node、`stage-tauri-host.ps1`/Cargo 和 ISCC | 两类 root 都 capture PID/start time/parent PID，并监视 CIM process snapshot 中的后代关系 |
| 现有取消 | Release Builder 的 AbortSignal 最终调用 direct child `child.kill()`；`component-lifecycle.killPid()` 用 taskkill tree，但没有这次 job 的 creation-time ownership proof | 不复用这两条不满足本 job ownership contract 的 kill 逻辑；按每个 PID 的 start time 和 parent PID 再次核对后，以进程 handle 定向终止，不按进程名批杀 |
| TestMode | build script 有真实 `-TestMode`，使用独立 output root，不写 `dist/update-stable.json` | 只执行 Planner 明确生成的 `-TestMode`；当前 Validator 会返回 provenance WARN，因此不能通过最终 Manifest gate |
| staging/tmp cleanup | build script 在接管 staging 后的普通失败路径清 staging；成功默认清 staging，只有显式 `-KeepStaging` 才保留。Host helper 在 `finally` 清 build mirror 和 cargo log | Executor 不清理 `dist`、`tmp`、ProgramData mirror 或其它 build 路径。强制终止可能绕过 PowerShell trap/finally，遗留 staging/mirror 作为待查现场 |

### 17.3 Execution Request

唯一接受的 request 形状是 `{ "job": { ...PackagingJob... } }`。顶层 command、script、artifact/output path、cwd、PowerShell 参数、environment 等额外字段会被拒绝。production API 不接收依赖/command override；隔离测试只通过不从 `index.js` 导出的 test hook 注入替身。

公共 API：`executePackagingJob(request)`、`cancelPackagingJob(jobId)`、`getPackagingJobState(jobId)`。`index.js` 不导出依赖替换面；`executor.js` 的 `__test.executePackagingJobWithDependencies()` 仅供 isolated tests 使用。普通 Job ID 在当前 Executor 进程的 registry 中必须唯一。

### 17.4 State Machine and Transition Gate

终态是 `COMPLETE`、`FAILED`、`CANCELLED`；terminal 后不允许转移。内部 transition helper 统一检查当前→下一状态，非法状态返回 `INVALID_STATE_TRANSITION`，不会静默改写。

```text
CREATED → PREFLIGHT → READY → BUILDING → BUILD_COMPLETE → VALIDATING → VALIDATED → WRITING_MANIFEST → COMPLETE
CREATED / PREFLIGHT / READY → CANCELLED
PREFLIGHT / BUILDING → CANCELLING → CANCELLED
Any active state → FAILED
```

| Current state | Allowed next states |
|---|---|
| CREATED | PREFLIGHT, FAILED, CANCELLED |
| PREFLIGHT | READY, CANCELLING, FAILED, CANCELLED |
| READY | BUILDING, FAILED, CANCELLED |
| BUILDING | BUILD_COMPLETE, CANCELLING, FAILED |
| CANCELLING | CANCELLED, FAILED |
| BUILD_COMPLETE | VALIDATING, FAILED |
| VALIDATING | VALIDATED, FAILED |
| VALIDATED | WRITING_MANIFEST, FAILED |
| WRITING_MANIFEST | COMPLETE, FAILED |
| COMPLETE / FAILED / CANCELLED | none |

所有未终态都可因前置错误进入 FAILED；PREFLIGHT/BUILDING 可转 CANCELLING；BUILD_COMPLETE 之后取消返回 `CANCELLATION_TOO_LATE`。`BUILDING → COMPLETE`、`BUILD_COMPLETE → COMPLETE`、`FAILED/CANCELLED → BUILDING` 均非法。

### 17.5 Preflight and Planner

Executor 先用固定的 `inspector-worker.js` 运行只读 Inspector，再调用 Planner 描述 BuildPlan。Worker 在 Executor capture 其 PID/start/parent 后才接收 `GO` 并开始 Inspector 的同步 probes，因此 PREFLIGHT cancel 可以终止被拥有的 worker 及其 probe 子进程。`ready !== true`、BLOCKED/UNSUPPORTED、delegate 不匹配或 `executes !== false` 都 fail-closed，且 build spawn 次数必须为 0。Executor 核对 plan 的 target/mode/version/outputRoot、固定 step 顺序、唯一 delegate 和精确参数；不接受任意 command。

release 必须满足 Planner 的 `releaseEligible === true`，并且 build-time revision 已知、sourceDirty 明确为 false。此条件沿用 Planner eligibility 和 Validator 的 provenance 完整性要求。TestMode 沿用 Planner 的隔离 output root，但当前 end-to-end gate 将在 Validator WARN 时拒绝它。

### 17.6 Canonical Build Delegation

Executor 只执行 BuildPlan 中的 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1`；test plan 仅追加 `-TestMode`。执行时 `shell:false`、cwd 为 repo root、环境来自 Inspector 白名单。没有 timeout request；本阶段不设置隐式短 timeout，也不采用 Release Builder 的整套 bump/rollback/publish orchestration。

Executor 不传 `-InstallAudit`，所以不会自动安装测试包；也不传 `-SkipAudit` / `-KeepStaging`。build exit 0 只进入 `BUILD_COMPLETE`，不是 job 成功。

### 17.7 Process Ownership and Cancellation

Build root 必须证明 PID、Creation/Start time、parent PID 与当前 canonical PowerShell command line 相符；preflight root 必须匹配固定 Node `inspector-worker.js` command line。Inspector worker 在 Executor capture ownership 后才开始 probes。运行期间每 1.5 秒记录可证明归属于 root 的后代。取消时只处理这些身份记录；终止 helper 在进程 handle 上再次比对 PID、start time 和 parent PID，确认后调用该 handle 的 `Kill()`。不使用 `taskkill /IM`、按名称停止进程或用户全局进程扫描后批杀。

- CREATED/PREFLIGHT/READY 可直接转 CANCELLED，build spawn 为 0。
- BUILDING 先提交 CANCELLING，再终止当前 owned process tree；确认进程已结束才转 CANCELLED。
- 若 ownership 无法确认，job 保持 CANCELLING、single-flight lock 不释放；可重试取消，不退化成按 PID/name 猜测。
- close event 已在 cancel request 前提交时，先记录自然 build 结果，取消拒绝为 `CANCELLATION_TOO_LATE`。取消状态先提交时，竞态结果固定为 CANCELLED；不会双终态。
- BUILD_COMPLETE 及之后取消拒绝。Executor 不删除 artifact、staging 或其它目录。

`owned-process.js` 的过程查询/终止使用 PID + start time + parent relationship，不记录命令行或环境 dump 到结果。当前没有 Windows Job Object，也没有跨 Executor 进程的 kernel-level job containment；若 ownership evidence 不足，会保持 fail-closed。

### 17.8 Single-flight and Job Registry

一个 Executor Node 进程同时只允许一个 active installer build；第二个通过 preflight 后在 READY 被拒绝为 `PACKAGING_BUSY`，不排队。Lock 从 BUILDING 持有至 COMPLETE/FAILED/CANCELLED，并在所有正常失败/取消终态释放。

Job registry 是进程内 Map，保存 id/state/timestamps/cancelRequested/ownedProcess/result；不落 SQLite、不持久化完整环境或 stdout。终态记录留在内存中以供状态查询；同一 ID 在当前进程不能复用。

### 17.9 Artifact Discovery and Identity Freeze

BUILD_COMPLETE 后通过 Validator 共享的 canonical naming/path boundary helper 只定位一个预期文件。不存在返回 `ARTIFACT_NOT_FOUND_AFTER_BUILD`；不扫描磁盘。冻结 A=`{name,size,sha256}` 后进入 VALIDATING。A 必须与 Validator 返回的 B 完全一致才允许继续；不一致返回 `ARTIFACT_IDENTITY_FAILED`。

### 17.10 Validator and Manifest Writer Integration

Executor 直接把当前进程中 `validateArtifact()` 返回的原对象传给 `writeArtifactManifest()`；不 JSON stringify/parse、IPC、clone 或落地中间 ValidationResult 文件。`PASS + valid:true` 是唯一通过条件；PASS_WITH_WARNINGS 返回 `VALIDATION_WARNINGS_NOT_ACCEPTED`，FAIL 返回 `VALIDATION_FAILED`，两者都不调用 Writer。

Writer `WRITTEN` 和 `ALREADY_IDENTICAL` 都可继续。冲突/写入/read-back失败进入 FAILED；build exit 0 或 artifact 存在都不能绕开这一 gate。

### 17.11 Final Identity / TOCTOU Gate

Writer 完成后 Executor 再测一次 C，只比较 artifact size/SHA-256。要求 A==B==C 才能进入 COMPLETE；变化返回 `ARTIFACT_CHANGED_DURING_FINALIZATION`。这只是 finalization identity confirmation，不重跑完整 validation。若该检查在 sidecar commit 后失败，Executor 保留 sidecar 和 artifact 供调查，不自动删除/修复。

### 17.12 PackagingExecutionResult and Logging

结果仅含 `status/job/build exit summary/artifact identity/validation summary/manifest summary/failure/events`；没有 artifact/repo absolute path、PID、stdout/stderr 原文、secret 或环境 dump。事件记录 timestamp、jobId、state、event 和 exitCode。Job Registry 内部保留 process ownership 信息，`getPackagingJobState()` 对外只返回 ownership 已捕获标志和后代数量。

### 17.13 Failure Codes

Executor 区分 `PREFLIGHT_FAILED`、`BUILD_PLAN_NOT_EXECUTABLE`、`RELEASE_NOT_ELIGIBLE`、`PACKAGING_BUSY`、`BUILD_SPAWN_FAILED`、`BUILD_FAILED`、`BUILD_CANCELLED`、`CANCELLATION_TOO_LATE`、`ALREADY_TERMINAL`、`INVALID_STATE_TRANSITION`、`ARTIFACT_NOT_FOUND_AFTER_BUILD`、`ARTIFACT_IDENTITY_FAILED`、`VALIDATION_FAILED`、`VALIDATION_WARNINGS_NOT_ACCEPTED`、`MANIFEST_WRITE_FAILED`、`MANIFEST_ALREADY_EXISTS_CONFLICT`、`ARTIFACT_CHANGED_DURING_FINALIZATION`、`PROCESS_OWNERSHIP_FAILED` 和 `EXECUTOR_INTERNAL_ERROR`。

### 17.14 Timeout, Cleanup and Crash Semantics

没有隐式 build timeout；可取消 job 持续到 exit 或显式 cancel。Inspector 的现有 spawnSync preflight probes 有各自短 timeout，但不是 installer build timeout。

普通 build failure 的 staging 清理由 canonical script 执行；Executor 只清理由本次 Executor 明确创建并登记的 transient state，不对整个 `tmp`/`dist` 做清理。`P35.5 does not provide durable job recovery.` Executor 崩溃会丢失 in-memory registry/lock，child process 是否存活取决于操作系统进程关系；没有 crash recovery 或自动 orphan sweep。

### 17.15 Security Boundary and Non-Goals

`release-audit` 继续只依赖其 canonical primitive；production audit 不依赖 Executor。Executor 不调用 Release Builder UI/server、不 bump VERSION/README、不改 installer、不安装、不发布、不签名、不上传。P35 control plane 仍被 canonical whitelist 排除。

### 17.16 P35.5 Tests

[`test_executor.js`](../../tools/packaging-control-plane/tests/test_executor.js) 全部使用 synthetic fixture/fake process，不运行 PowerShell build、Cargo、ISCC 或 installer。覆盖 happy path、preflight/planner gates、非零 exit、missing artifact、Validator FAIL/WARN、身份不一致、Writer conflict、finalization mutation、前/中/过晚取消、双重取消、PID reuse/parent ownership、single-flight 和失败后 lock release。

本阶段不运行真实 release build。TestMode 当前可委托 canonical `-TestMode` 参数，但其 ValidationResult 仍有 provenance WARN，故它会在硬 gate 失败而不会生成 Artifact Manifest 或 COMPLETE。

### 17.17 Lock Lifetime

Single-flight lock 在 READY→BUILDING 前同步取得，并覆盖 build、artifact validation、manifest 写入和最后一次 identity confirmation；只有 COMPLETE/FAILED/CANCELLED 终态才释放。PREFLIGHT 不占 build lock。若 process ownership 无法确认，job 保持 CANCELLING 且 lock 保留，不启动第二个可能冲突的 build。

### 17.18 TestMode Completion Policy

TestMode delegate 是 canonical `scripts/build-installer.ps1 -TestMode`，输出到隔离的 `tmp/installer-smoke-build`。当前 P35.3 对 test provenance 返回 WARN，P35.4 因此拒绝 manifest；Executor 会返回 `VALIDATION_WARNINGS_NOT_ACCEPTED`，不会把 test compile exit 0 报成 COMPLETE。

### 17.19 Crash Semantics

`P35.5 does not provide durable job recovery.` Registry 与 single-flight lock 在内存中；Executor 崩溃可能使记录丢失，PowerShell/子进程是否存活由 OS 关系决定。重启后没有 orphan sweep，也不会自动删 staging、Host mirror、artifact 或 sidecar。

### 17.20 Next Phase Recommendation

P35.5 已完成并停止。任何 UI、跨进程 job service、Windows Job Object containment、durable recovery、remote build、签名或发布工作都需要单独阶段授权；Portable/Web/Android 仍不在当前 Executor 支持范围。

## 18. P35.6 Self-Service Packaging Center

### 18.1 UI Purpose

Packaging Center 是 P35 Control Plane 的 presentation layer：显示 Windows Installer 版本、Inspector 结果、只读 Build Plan、Executor 状态、当前服务进程内的任务摘要。它不重新设计构建系统，也不替代 Release Builder、`scripts/build-installer.ps1` 或 Inno Setup。

页面只提供 `windows-installer` 的 `release/stable` 流程。Test mode 当前会被 P35.5 的 Validator warning gate 拒绝，debug artifact path 未获 Planner 支持，因此都不显示成可执行选项。Portable、Web Export、Android APK 仅以 `Coming later` 文本展示。

### 18.2 IB Visual Language Map

| 维度 | 仓库现有模式 | Packaging Center 复用方式 |
|---|---|---|
| Layout | `#navbar` 横向导航；内容通过 `.page` 单页切换；常规页面居中、默认最大宽度约 900px；无全局左侧 Dashboard sidebar | 新增普通 `page-packaging` 路由；工作台最多 1120px，标题左对齐；产品身份条、环境与计划双栏、执行轨道及 session jobs 顺序排列 |
| Typography | `--font-ui: Noto Sans SC`；`--font-display: Cormorant Garamond`；`--font-reading: Noto Serif SC`；常见正文约 0.78–0.95rem，内容页标题使用 Cormorant Garamond | 页面标题继承内容页标题系统；面板标题用 Noto Serif SC；状态/检查正文用 Noto Sans SC；SHA-256 使用系统等宽字体 |
| Color | 主题语义色：`--bg-deep #181e32`、`--bg-mid #263050`、`--accent #5080b0`、`--status-success #6f9f83`、`--status-warning #b58a55`、`--status-danger #c78282`；panel/card/border/text 使用 light/dark 主题变量 | 只引用现有 tokens；不创建 Packaging 专属蓝/绿或全局 token。深浅主题通过既有变量反转 |
| Spacing / surfaces | `--space-1` 到 `--space-6` 为 4–24px；`.glass-card` 使用主题表面、圆角和既有玻璃层级 | 局部组件沿用 `.glass-card`、`.btn`、`.btn-primary`、`.btn-danger` 和 spacing scale；不增加 KPI 卡片组或背景渐变 |
| Components | API/设置页使用分段 panel、按钮和折叠；Memory 有独立 timeline；Economy 页采用领域内专用状态样式；没有统一的全局状态 chip | 状态以简短文本和既有 semantic status color 表示；执行阶段做成此页面内的只读 sequence rail，不新增全局 component |
| Tauri Host | 与 Browser 共用 `InternalBeyond.html` / `IB.host`；Tauri 通过现有本地 Web server 承载同一 Web Core | 不创建第二套 native panel；页面仍走现有单页导航和同源服务 |

设计审查：初稿若做成 KPI 数字、渐变 banner、通用 Dashboard sidebar，会与 IB 当前横向导航和雾化玻璃页面模式脱节；最终布局保留一条固定的 canonical build route 作为主结构，以状态和职责层级组织内容，不添加装饰性指标。

### 18.3 Permission Boundary

UI 只能构造固定字段的 PackagingJob 并调用同源 API。它不含 shell、PowerShell、PID、输出路径、环境变量、凭据或 artifact-path 输入，不调用 Tauri shell command，不调用 Executor 之外的构建入口。版本由服务端读取仓库 `VERSION`；目标固定为 `windows-installer`；模式和 channel 固定为 `release/stable`；安全 options 固定为 false。

本地 `services/internal-beyond-server.js` 通过 `services/packaging-center-api.js` 适配器调用 P35.5 公共 API。入口复用现有 loopback / same-origin source gate，无 CORS 放宽；请求体限制 8 KiB。API 路由为：

| Endpoint | 用途 |
|---|---|
| `GET /__packaging/preflight` | 调用 Inspector 和 Planner；只返回 check label/status、plan label/status 与服务端计算的 start eligibility |
| `POST /__packaging/jobs` | 只接受 `{ "job": { ... } }`；服务端重验 Contract、canonical version、固定 target/mode/channel 后调用 `executePackagingJob({ job })` |
| `GET /__packaging/jobs` | 返回当前静态服务进程内登记的 session jobs |
| `GET /__packaging/jobs/:id` | 返回该 session job 的状态与安全结果投影 |
| `POST /__packaging/jobs/:id/cancel` | 只转发 `cancelPackagingJob(jobId)` |

`getPackagingJobState()` 是 result summary 的唯一数据来源。API 丢弃 Inspector 原始 message、Planner command/outputRoot/authority 字段、PID ownership details、stack/error text、stdout/stderr 与完整 environment；只允许 artifact name/size/SHA-256、validation status、manifest status、failure code 和受限 event fields 到达 UI。DOM 更新使用 `textContent`，不把 API 字符串作为 HTML 解析。

### 18.4 Page Structure

页面由产品身份条（Windows Installer / canonical version / Stable release）、Environment panel、只读 Build Plan panel、Executor timeline、Build result 和 Current Session Jobs 组成。计划条目只显示固定 label 与 status。Artifact result 不显示绝对路径，也没有打开文件的 action；如以后需要文件打开，应另行设计受控 API。

### 18.5 State Mapping

| Executor state | 页面展示 | 可用操作 |
|---|---|---|
| CREATED | Created | 可取消 |
| PREFLIGHT | Checking environment | 可取消 |
| READY | Ready | 可取消 |
| BUILDING | Building installer | Cancel Build |
| BUILD_COMPLETE | Build finished | 取消禁用，等待 validation |
| VALIDATING | Validating artifact | 取消禁用 |
| VALIDATED | Validation passed | 取消禁用，等待 manifest |
| WRITING_MANIFEST | Writing manifest | 取消禁用 |
| COMPLETE | Complete | 显示受限 artifact/result summary |
| FAILED | Failed | 显示 failure code 与固定用户文案 |
| CANCELLING | Cancelling | 可再次通过 Executor 请求取消 |
| CANCELLED | Cancelled | 显示取消结束状态 |

开始按钮由服务端 Inspector/Planner 的 `actions.start` 决定；活跃 job 与取消可用性来自 Executor 状态。UI 不根据自己的推断将 job 标成 READY、PASS 或 COMPLETE。取消前通过现有主题化 `<dialog>` 确认，最终结果只以 Executor 返回状态为准。

### 18.6 Executor API Usage

前端 `assets/js/packaging-center.js` 暴露 `createPackagingJob()`、`getPackagingJobState()`、`cancelPackagingJob()` 对应的页面 client；它通过 `fetch('/__packaging/...')` 访问本机服务，不加载 Control Plane CommonJS 模块。开始请求严格包裹为 `{ job }`；刷新/回到页面时读取服务端 in-memory session 列表。环境卡片不自行运行工具探测，所有值来自 Inspector endpoint。

### 18.7 Security Rules

- server 将 request root 固定为自己的 workspace root，不从 URL/body 接收 cwd 或文件位置。
- `contract.validatePackagingJob()` 拒绝未知字段和受限字段；API 再收紧 target、mode、channel、version。
- 输出通过显式字段投影；不向 UI 返回 command、absolute path、environment、PID 或原始日志。
- 服务端执行仍全部由 P35.5 Executor 管理；API 层不启动 shell，不直接调用 `scripts/build-installer.ps1`。
- Executor 的 Validator PASS 与 Manifest Writer gate 不因 UI 状态或本地页面变化而改变。

### 18.8 Current Limitations

canonical payload 只新增同源 API adapter 与 UI assets；`tools/packaging-control-plane/**` 仍不进入 release whitelist，payload match 必须保持 0。因此从已安装产品打开页面时，若源码 Control Plane 缺失，服务端返回 `PACKAGING_BACKEND_UNAVAILABLE`，页面明确提示该构建没有源码打包工具并禁用开始按钮。只有具备源码构建工具的 Windows source workspace 能运行此流程；dirty workspace 仍按 Planner release eligibility 禁止 release build。

Session job list 存在本地静态服务进程的内存中，不写数据库、不提供 crash recovery。当前只支持 Windows Installer release；没有 artifact-open action、诊断信息复制、多用户队列、Portable/Web/Android、签名、上传或发布。

### 18.9 Future Extensions

后续阶段可单独评估 UI 受控打开 artifact、更多 target 的独立 Validator/Manifest contract、job persistence 与 crash recovery。任何 target、签名、上传或发布扩展都必须先有独立 authority 和验证 contract；不得仅添加一个前端按钮。
