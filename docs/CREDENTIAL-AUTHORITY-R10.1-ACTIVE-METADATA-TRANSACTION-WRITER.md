# Credential Authority R10.1 Active Metadata Transaction Writer

日期：2026-09-22（Asia/Shanghai）

R10：BLOCKED before production write  
R10.1：PASS / writer blocker resolved

R10.1 建立了 Active persistence owner 内的 target-scoped metadata transaction seam。它只允许 synthetic non-credential field，未写入 credentialRef、apiKey 或任何 production data。

新增/修改：

- active/persistence.js：canonical metadata transaction/rollback primitive。
- services/active-message-service.js：只导出 transaction seam，未接入 startup/scheduler/HTTP。
- tests/test_r10_1_active_metadata_transaction.js：isolated Active composition-root contention test。

## A. Scope

R10.1 完成：

- Active canonical in-memory state owner audit。
- saveNow/queueSave/atomic persistence audit。
- target-scoped metadata mutation seam。
- promise-chain serialization primitive。
- metadata-only snapshot/readback/rollback。
- synthetic live-writer contention test。
- idempotency and failure boundary test。

R10.1 不做：

- credentialRef write。
- credential migration。
- Active production state write。
- scheduler pause/stop。
- provider/model call。
- Vault/recovery/Bridge/Home Node mutation。
- R10 production shadow migration resume。
- R11。

## B. Existing Active Write Authority Audit

### B1. Canonical in-memory owner

services/active-message-service.js:45-47：

- createPersistence({ dataDir, getState: () => state })。
- state 由 services/active-message-service.js:47 的 composition root 持有。
- persistence 不缓存 state 引用，save 时通过 getState() 读取当前 canonical state。

### B2. Persistence owner

active/persistence.js:11-18 创建 persistence owner，并集中定义：

- main state file。
- temp file。
- backup file。
- loadData()。
- saveNow()。
- queueSave()。

### B3. Production mutation paths

只读扫描确认以下生产模块可以 mutate canonical state 或调用 save：

- active/http.js：HTTP tasks/plans/moments/events/history mutations；saveNow/queueSave 见 :257,289,307,373,392,483,502,591,636,680。
- active/plan-domain.js：plan/task mutation，saveNow 见 :446。
- active/moments.js：moments/reply/task mutation；saveNow/queueSave 见 :325,516,567,684,734,811,831,839,847,858,866,989,996,1005,1071,1102,1126,1154。
- active/scheduler.js：scheduler/task/plan state mutation；saveNow/queueSave 见 :189,211,255,301,346,387,552,561,575,588,594,603,632,638,667,713,771,803,835。
- services/active-message-service.js:452：cooperative shutdown flush 调用 saveNow()。

### B4. Serialization facts

现有 saveNow() 是同步函数，Node event loop 不会在一次同步 state mutation/saveNow 序列中插入另一个 JS callback。

现有 queueSave() 在 active/persistence.js:228-242：

- 合并 50ms 内的 queued save。
- save 时重新从 getState() 读取当前 state。
- 不保存 stale external JSON copy。

原有 direct saveNow/queueSave 路径仍然保留，R10.1 不重构 scheduler/HTTP。

## C. Canonical Writer Design

R10.1 在 active/persistence.js 增加：

- mutateTargetMetadata(request)。
- rollbackTargetMetadata(snapshot)。

services/active-message-service.js 只导出这两个 seam；没有在 startup、scheduler、HTTP 或 frontend 自动调用。

canonical flow：

    mutateTargetMetadata
      ↓
    mutation promise chain
      ↓
    current getState()
      ↓
    allowlisted target mutation
      ↓
    existing saveNow()
      ↓
    readback

rollback 通过同一个 mutation chain 和 saveNow() 完成，禁止直接 patch JSON。

## D. Serialization Contract

mutationChain 是每个 persistence owner 实例内部的 promise chain：

- 同一 persistence owner 的 metadata transactions 按顺序执行。
- transaction callback 在 canonical in-memory state 上同步 mutate。
- saveNow() 读取当前 state，不读取 stale external JSON。
- 现有 scheduler/HTTP mutation 仍然操作同一个 canonical state。
- transaction 与 runtime mutation 在 Node event loop 中不会并发进入同一个同步 mutation/save 区段。
- queueSave() 的 pending timer 会在 saveNow() 内被清除并立即持久化当前 state。

R10.1 没有新增大型 mutex/dependency，也没有修改 persisted schema/version。

## E. Target-Scoped Mutation Contract

R10.1 只允许以下 targetType：

- moment_character。
- plan_character。
- task_character。

R10.1 只允许一个 synthetic field：

    __r101_test_marker

字段限制：

- patch 只能包含一个字段。
- 值必须是 string。
- 值长度上限 256。
- targetId 长度上限 180。
- transactionId 长度上限 120。
- credentialRef、apiKey、imageGenApiKey、secret、fingerprint 等字段全部拒绝。
- arbitrary object path 不允许。
- 任意 JSON patch 不允许。

target 必须是已有 character metadata object；不存在的 target 返回 R101_TARGET_NOT_FOUND，不创建对象。

## F. Snapshot / Revision Model

R10.1 snapshot 是 target-scoped metadata snapshot：

- schemaVersion。
- transactionId。
- targetType。
- targetId。
- field。
- field existence。
- old field value。

R10.1 不新增 persisted revision 字段。现有 canonical state + synchronous saveNow + transaction chain 足以完成本阶段 synthetic target 的 readback/rollback。

transaction ledger 是 process-local：

- APPLIED。
- ROLLED_BACK。
- ALREADY_APPLIED。
- ALREADY_ROLLED_BACK。

它不是 credential record，也不写 production state。

## G. Atomic Persistence

existing active/persistence.js:195-226 的 saveNow() 已具备：

1. 写同目录 temp sibling。
2. fsync temp file。
3. 原 main file rename 到 backup。
4. temp rename 到 canonical main file。
5. 尝试 fsync data directory。
6. final rename 失败时从 backup 恢复 main file。

R10.1 复用该 atomic persistence，不重新实现文件写法、不改变 JSON schema、不创建第二 authority。

## H. Writer API Boundary

R10.1 transaction seam 是 internal-only：

- 不新增 HTTP endpoint。
- 不新增 frontend write permission。
- 不接受任意 file/path/object path。
- 不接受 credential fields。
- 不接受 provider data。
- 不被 Active startup/scheduler 自动调用。

R10.1 test 通过 services/active-message-service.js 导出的 internal seam 调用，使用隔离 IB_ACTIVE_DATA_DIR。

## I. Live Writer Contention Test

tests/test_r10_1_active_metadata_transaction.js 使用真实 services/active-message-service.js composition root，但数据目录是系统临时目录。

测试模拟：

1. Active canonical state 中创建两个 synthetic moment targets 和 plan/task targets。
2. 发起 metadata transaction。
3. 在 transaction callback 执行前模拟 runtime/scheduler mutation + saveNow()。
4. transaction 再写 synthetic marker。
5. readback 验证 runtime mutation 与 marker 都保留。
6. 验证其他 target 未变化。

结果：

- live writer contention：PASS。
- lost update：未发生。
- corrupted JSON：未发生。
- stale external overwrite：未发生。
- provider call：0。

这是 isolated Active composition-root contention test，不是停止或干扰当前 production service。

## J. Readback

readback 验证：

- target marker 存在。
- runtime mutation 同时保留。
- plan/task/other moment 未出现 marker。
- snapshot old field existence/value 与 readback 一致。
- production data 未被测试触碰。

## K. Rollback

rollback flow：

    snapshot
      ↓
    synthetic metadata mutation
      ↓
    canonical saveNow
      ↓
    readback
      ↓
    rollback through same mutation chain
      ↓
    canonical saveNow
      ↓
    exact target restore

结果：

- rollback restored：true。
- unrelated runtime mutation 保留：true。
- duplicate rollback：ALREADY_ROLLED_BACK。
- production rollback：未执行，因为 R10.1 使用 isolated data。

## L. Idempotency

同一 transactionId 重放：

- 第一次：APPLIED。
- 第二次：ALREADY_APPLIED。

同一 snapshot rollback：

- 第一次：ROLLED_BACK。
- 第二次：ALREADY_ROLLED_BACK。

不会产生 duplicate metadata 或 transaction garbage。

## M. Failure Injection

已验证：

- credentialRef field：R101_FIELD_NOT_ALLOWED。
- invalid target type：R101_TARGET_TYPE_NOT_ALLOWED。
- invalid target：R101_TARGET_NOT_FOUND。
- invalid transaction id：R101_TRANSACTION_ID_INVALID。
- oversized metadata value：R101_METADATA_VALUE_INVALID。
- transaction without explicit state：rejected。
- readback mismatch path：defined and rolls back through saveNow。

R10.1 不测试真实 credential field，也不把 credentialRef 加入 allowlist。

## N. Credential Invariance

R10.1 前后：

- credential-vault.json：unchanged。
- credential-vault.key：unchanged。
- apiConfigs_recovery_import.json：unchanged。
- production apiConfigs：未写。
- Middle Brain config：未写。
- Image Router config：未写。
- Bridge config：unchanged。
- Home Node credential：unchanged。

Credential writes：0。  
Credential secret reads：0。  
Provider calls：0。

## O. Production Invariance

R10.1 没有：

- 停止 Active Service。
- kill Active PID。
- 直接 patch active-message-service.json。
- 修改 scheduler runtime。
- 修改 production business state。
- 创建 credential sidecar。
- 创建 credential HTTP backdoor。

工作区唯一新增的是 R10.1 source/test/report；production data unchanged。

## P. Regression

通过：

- R10.1 Active metadata transaction test。
- R5 read-only adapter regression。
- R6 UI cutover regression。
- R7 capability regression。
- R8 migration-prep regression。
- R9 shadow migration regression。
- JS syntax checks。

frontend structure suite 的 7 个 BOM failures 与 R10.1 之前完全相同，标记为 PRE-EXISTING；R10.1 没有新增 failure。

## Q. R10 Retry Gate

R10.1 blocker resolution：

1. canonical Active writer owner identified：PASS。
2. metadata mutation serialized：PASS。
3. no direct external JSON patch：PASS。
4. target-scoped mutation verified：PASS。
5. unrelated state unchanged：PASS。
6. atomic persistence reused/verified：PASS。
7. live-writer contention synthetic test：PASS。
8. readback verified：PASS。
9. rollback exact restore：PASS。
10. idempotency verified：PASS。
11. credential writes：0。
12. credential secret reads：0。
13. provider calls：0。
14. no new regression failure：PASS。

R10 writer blocker：**RESOLVED**。

RESOLVED 不等于自动继续 R10 Production Shadow Migration。R10 仍需重新执行 Phase A-D，并需要新的明确批准。

## Closure Gate

Canonical writer：active/persistence.js。  
Serialization：process-local promise chain + canonical synchronous state mutation。  
Atomic persistence：existing temp/fsync/rename/backup path。  
Target-scoped mutation：PASS，仅 synthetic __r101_test_marker。  
Live contention：PASS，isolated Active composition root。  
Readback：PASS。  
Rollback：PASS。  
Idempotency：PASS。  
Credential writes：0。  
Credential secret reads：0。  
Provider calls：0。  
Unexpected production changes：0。  
R10 writer blocker：RESOLVED。

R10.1 完成后立即停止。R10 production shadow migration、R11 和任何 credentialRef write 均未开始。
