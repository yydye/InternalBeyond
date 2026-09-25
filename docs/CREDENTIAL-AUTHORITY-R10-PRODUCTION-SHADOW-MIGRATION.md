# Credential Authority R10 Production Shadow Migration

日期：2026-09-22（Asia/Shanghai）

R0-R9：immutable baseline  
R10：BLOCKED before production write

R10 已完成 Phase A / B / C / D 的只读 gate，但没有进入 Phase F production shadow write。

阻断原因：

- 当前 Active Message service 正在运行并持有 active-message-service.json writer。
- 当前没有已建立的 credentialRef shadow writer/transaction endpoint。
- 直接改写 active-message-service.json 会与 scheduler/saveNow 竞争，并可能重写无关业务 state。
- R10 禁止为了写 shadow metadata 而绕过 live writer、启动/停止 scheduler 或临时扩展业务 schema。

因此本轮没有 production shadow state，没有生产 metadata write，也没有创建假 persistence target。

## A. Scope

R10 只完成：

- 生产 persistence target audit。
- shadow schema/preflight 设计。
- production preflight dry-run。
- write gate 判定。
- 无写入停止条件记录。

R10 未执行：

- credentialRef production shadow write。
- apiKey 删除/覆盖。
- Vault/recovery/emergency mirror cleanup。
- API Config、Middle Brain、Image Router、Voice、Bridge、Home Node migration。
- provider/model validation。
- provider call。
- Backup v2、Storage Convergence、P33、Android 或 Jev。

## B. Production Persistence Target Audit

| Consumer | Current target | Current evidence | Classification | Write decision |
|---|---|---|---|---|
| apiConfigs | current isolated WebView apiConfigs | records=0，fallback absent | NO_PERSIST_TARGET | 不创建、不写 |
| Middle Brain | apiSettings['middle_brain'] | current isolated profile target record=0 | NO_PERSIST_TARGET | 不创建、不写 |
| Image Router | apiSettings['image_router'].routes | current isolated profile route record=0 | NO_PERSIST_TARGET | 不创建、不写 |
| legacy browser voice | apiSettings voiceTrans | current isolated profile target=0 | KEEP_SEPARATE | 不迁移 |
| TTS/ASR/Voicebox | Bridge config/local runtime | Bridge-owned | KEEP_SEPARATE | 不迁移 |
| Home Node | desktop credential | Home Node-owned | KEEP_SEPARATE | 不迁移 |
| Active Message | active-message-service.json moments/plans character metadata | 22 live bindings，23 metadata locations | BLOCKED | 不写 |

Active target 的结构事实：

- 21 个 credential-required bindings 在 moments character metadata 中有 target。
- 其中 1 个 binding 还有 plan character metadata duplicate。
- char_bgai 为 NO_CREDENTIAL_REQUIRED，不创建 shadow ref。
- Active service PID 13376 正在运行。
- service 使用 persistence.saveNow()，scheduler/HTTP path 都可能写回 active-message-service.json。
- 当前没有已注册的 shadow metadata write API。

虽然 JSON object 能容纳额外字段，但“能容纳”不等于已存在安全 persistence target。R10 不临时把任意业务 character object 变成 migration writer。

## C. Shadow Schema

如果未来建立安全 writer，最小 shadow metadata 形状应为：

- credentialRef。
- credentialAuthority。
- credentialSchemaVersion。

推荐写入位置：

    existing Active character metadata
      + credentialRef shadow field
      + credentialAuthority: desktop-local
      + credentialSchemaVersion: 1

写入要求：

- legacy apiKey field/value 保持原样。
- 不写 raw key、fingerprint、ciphertext 或 provider token。
- 不改变 endpoint/model/provider。
- 不改变 scheduler/plan/moment execution semantics。
- 只对已有合法 target 写入。

R10 没有执行该 schema write，因为 target writer 处于 BLOCKED 状态。

## D. Preflight Snapshot

R10 只读计算了 snapshot 所需 metadata shape，没有创建 production transaction artifact：

- target record identity。
- field existence。
- intended shadow fields。
- authority scope。
- schema version。
- rollback pointer shape。
- target structural hash/stat。

没有创建 snapshot file 的原因：

- 没有 production write authorization gate。
- 创建与 production consumer 绑定的 transaction artifact 会先改变生产状态。
- 当前没有安全 writer 可以保证 snapshot/commit/rollback 与 live Active writer 原子协调。

R9 staging transaction 与 rollback drill 已通过，但不被当作 R10 production authorization。

## E. Production Dry Run

R10 Phase D dry-run：

| Metric | Count |
|---|---:|
| Candidate bindings | 22 |
| Persistable targets | 0 |
| No persistence target | 0 |
| Keep separate | 0 |
| No credential required | 1 |
| Resolved | 22 |
| Unresolved | 0 |
| Conflict | 0 |
| Blocked | 21 |

Resolved breakdown：

- 21 credential-required bindings：status ready。
- char_bgai：status none。
- unresolved：0。
- R2 historical alternate conflicts：不重新裁决，新 conflict=0。

Dry-run mapping 没有因 unresolved/conflict 停止；真正阻断条件是 production persistence writer safety。

## F. Commit Gate

R10 独立 production commit gate 未打开。

本轮没有执行：

- production approval token。
- migration commit。
- service stop/restart。
- Active state write。
- API Config write。
- Middle Brain/Image/Voice write。

默认状态保持 DENY。后续若继续，必须先建立一个明确的 Active metadata transaction writer，支持：

- writer quiescence。
- target-scoped snapshot。
- atomic shadow write。
- post-write readback。
- exact rollback。

不能把 R9 synthetic approval token 复用于 production。

## G. Production Shadow Write

Written targets：0。

原因：

- Active writer live。
- 无安全 shadow writer。
- 其他 consumer 当前无合法 persistence target。
- R10 禁止创建假 target 或临时扩大 schema。

Final shadow state：NO PRODUCTION SHADOW STATE。

## H. Post-Write Readback

未执行 production post-write readback，因为没有 production write。

R9 staging readback/rollback 仍有效：

- legacy + credentialRef coexistence：PASS。
- rollback restored：true。

R10 不把 staging readback 冒充 production readback。

## I. Runtime Regression

R10 没有改变 runtime：

- Active execution unchanged。
- Active scheduler 未为迁移而停止/启动。
- API Config/UI status authority unchanged from R6。
- Middle Brain/Image Router/Voice execution unchanged。
- Bridge/Home Node ownership unchanged。
- Provider calls：0。

## J. Rollback Drill

R10 production rollback drill 未执行，因为没有 shadow write。

R9 staging rollback drill 已通过，但 R10 明确区分：

- ROLLBACK DRILL：R9 staging transaction，已验证。
- FINAL SHADOW STATE：R10 production，无 shadow state。

## K. Final Shadow State

R10 final shadow state：

- Production Active metadata：unchanged。
- Production API Config：unchanged。
- Middle Brain config：unchanged。
- Image Router route metadata：unchanged。
- Bridge/Home Node/Voice：unchanged。

## L. Secret Leakage Audit

R10 没有产生 migration artifact、snapshot file、IPC payload 或 production response。

输出中没有：

- raw key。
- raw fingerprint。
- key prefix/suffix。
- Authorization/Bearer。
- ciphertext。
- decrypted Vault record。

Secret leakage：0。

## M. Production Invariance

R10 前后：

| Artifact | Status |
|---|---|
| credential-vault.json | UNCHANGED |
| credential-vault.key | UNCHANGED |
| apiConfigs_recovery_import.json | UNCHANGED |
| active-message-service.json | UNCHANGED |
| Bridge config | UNCHANGED |
| Home Node credential | UNCHANGED |
| chatMessages | UNCHANGED |
| Memory | UNCHANGED |
| Relationship | UNCHANGED |
| Activity | UNCHANGED |
| Diary | UNCHANGED |
| Moments | UNCHANGED |
| Role Letters | UNCHANGED |

Production credential writes：0。  
Production business-data writes：0。  
Provider calls：0。

## N. Tests

已完成：

- R10 production preflight dry-run：通过 mapping，因 target writer blocked 停止。
- R9 transaction regression：通过。
- R5 read-only adapter regression：通过。
- R6 UI cutover regression：通过。
- R7 capability regression：通过。
- unresolved/conflict gate：通过，均为 0。
- Active live baseline：22 refs / 21 ready / 1 none：通过。

未执行：

- production commit。
- production rollback。
- provider request。

## O. R11 Entry Gate

R10 当前不满足 production shadow write gate，因为：

- Persistable targets：0。
- Active target：BLOCKED_LIVE_WRITER。
- Production shadow state：未建立。

R11 不得开始。即使未来建立安全 writer，也必须再次取得明确批准，并重新执行 Phase A-D。

## Closure Gate

R10 = **BLOCKED before production write**。

原因不是 credential mapping unresolved，也不是 conflict；原因是当前唯一有 live target 的 Active consumer 没有可安全协调的 production shadow writer，且 Active service 正在运行。

最终计数：

- Candidate bindings：22。
- Persistable targets：0。
- Written targets：0。
- Skipped no-target：0。
- Keep separate：0。
- Resolved：22。
- Unresolved：0。
- Conflict：0。
- Rollback：R9 staging only；R10 production not executed。
- Final shadow state：none。
- Secret leakage：0。
- Provider calls：0。
- Unexpected production writes：0。

完成 R10 后停止，不 commit，不 push。R11 需要重新获得明确批准。

## R10 Retry / Post-R10.1

本节追加记录 R10 Retry；上方首次 R10 BLOCKED 记录保持不变。

### Retry conclusion

R10.1 已在 workspace source/test 层完成并通过：canonical `saveNow()` transaction writer、target-scoped readback、duplicate commit、rollback 与 duplicate rollback 均有覆盖。该结果只证明 writer 本身可用，不等于当前 production Active owner 已载入该 seam。

Retry 的 live-owner 复核结果：

- Active health：HTTP 200。
- Active PID：13376。
- live command：已安装 payload 下的 `[local path redacted]`。
- 已安装 `active-message-service.js` / `active\persistence.js`：未发现 R10.1 transaction writer 引用。
- 当前没有已认证、target-scoped、可与 live writer 协调的跨进程 shadow metadata command/transport。

因此不能安全地把 workspace writer 直接用于 live installed process，也不能将 health 或任意 HTTP endpoint 当作迁移写入通道。按照 R10 safety gate，本次 Retry 在 production write 前停止。

### Retry Phase A-D rerun

| Phase | Result | Evidence / decision |
|---|---|---|
| Phase A · consumer audit | PASS with classification | apiConfigs、Middle Brain、Image Router 当前无 candidate persistence target；legacy browser voice、Bridge、Home Node 保持 `KEEP_SEPARATE`；Active Message 有 21 个 credential-required live bindings 和 1 个 `NO_CREDENTIAL_REQUIRED` binding。 |
| Phase B · mapping/schema | PASS | 22 candidate bindings；credentialRef mapping resolved=22、unresolved=0、conflict=0；不包含 raw key、fingerprint 或 secret material。 |
| Phase C · snapshot/transaction gate | BLOCKED | R10.1 writer 已在 workspace source/test 层通过，但 live installed Active owner 未加载该 writer；没有安全的 cross-process writer seam，因此不创建 production snapshot/transaction artifact。 |
| Phase D · production commit gate | BLOCKED before write | persistableTargets=0；不执行 commit、readback 或 rollback。 |

Retry dry-run 计数：

| Metric | Count |
|---|---:|
| Candidate bindings | 22 |
| Persistable targets | 0 |
| No persistence target | 0 |
| Keep separate | 0 |
| No credential required | 1 |
| Resolved | 22 |
| Unresolved | 0 |
| Conflict | 0 |
| Blocked live Active bindings | 21 |
| Production metadata writes | 0 |
| Provider calls | 0 |

### Retry production decision

本次没有执行第一次 production shadow metadata write。以下操作均未发生：

- 没有写入 `credentialRef`、`credentialAuthority` 或 `credentialSchemaVersion`。
- 没有写入 Vault、IndexedDB、localStorage、Bridge config 或 Home Node DB。
- 没有停止、重启或 kill Active service。
- 没有直接 patch `active-message-service.json`。
- 没有 provider call。
- 没有创建假 persistence target 或 fake production record。

Rollback 未执行，因为没有 production shadow write；R9 staging rollback 结果仍为 PASS。production invariance 保持：production credential writes=0，production business-data writes=0，unexpected production changes=0，secret leakage=0。

### Retry closure

R10 Retry = **BLOCKED before production write**。

阻断条件是 live installed Active owner 未载入 R10.1 writer，且没有安全的已认证跨进程 transaction command。R10.1 source/test PASS 不足以授权 production write。

R11 未开始。任何后续 production shadow write 都必须先提供可验证的 live-owner transaction seam，并重新取得明确批准；本阶段到此停止。
