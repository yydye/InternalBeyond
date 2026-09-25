# P30-2 Workspace Conversation Scope Implementation

阶段性质：**IMPLEMENTATION**（按 P30-1 冻结契约实施；未重开契约、未引入新 authority/manager/bus/store）。

---

## 1. State

**P30-2 State: PASS**

Workspace Conversation Scope **closed**：producer 写入 `(friendId, threadId)`；consumer 只消费同会话条目；
不匹配项 **KEEP**；scope 缺失（legacy / intentionally unscoped）保持旧行为。

---

## 2. 修改文件列表

| 文件 | 类型 | 内容 |
|---|---|---|
| `assets/js/workspace.js` | production | 新增 `_wsScopeFragment(src)`（WHERE 字段归一，缺失 ⇒ null）；`_execWsOps` 计算 `_sc` 并用 `_pushOpFeedback` 统一入队（op-feedback 6 处）、read entry、`_rCtx`、`_ibExecToolOp(...)` 透传、`_wsCheckPhantom(...,scopeSrc)`、run/tool 卡片 ctx 携带 scope、`continueTruncatedMsg` 补传 ictx（会话取自该 canonical 消息） |
| `assets/js/workspace/run.js` | production | `_wsQueueRunOutput` 把 `ctx.friendId/threadId` 搬进 run-output 条目 |
| `assets/js/site-operations.js` | production | `_ibQueueToolResult(...,actorId,scope)`、`_ibExecToolOp(op,author,ictx,actorId,scope)` → Inner；4 处 `_ibToolPendingResults` / 3 处 `_wsPendingOpFeedback` / pendingConfirm 返回值携带 scope；`_ibConfirmToolFromCard` 卡片路径透传 |
| `assets/js/communication.js` | production | 新增 `_ibWsScopeFilter(friendId,threadId)`（消费谓词，比较键经既有 `_ibConvId`）；群 `_gInjMine` 增加 scope 合取项（`_gCurConv` 由群 id + 透传 threadId 派生）；群 `buildChatContext` 透传 `threadId`；1:1 上下文与 tool continuation 注入加 scope 过滤；三处 `_wsCheckPhantom` 透传 scope；导出 `window._ibWsScopeFilter`（测试入口） |
| `tests/test_workspace_conversation_scope.js` | 新增测试 | C1–C8（30 checks） |
| `tests/test_workspace_actor_identity.js` | 测试守卫更新 | 7 条**源码形状**守卫按 P30-2 新形状重写（A1.* 五条 + A12.* 两条），语义强度不变；行为断言未改 |
| `tests/test-all.js` | 仅登记 | browser 组新增一条 |

**未修改**：`group-runtime-core.js` · P23 五核心 · `memory.js` · `middle-brain*` · `autonomy-core.js` ·
`agent-runtime.js` · `core.js`（`DB_VER`/schema）· `delivery-runtime.js`（仅作 precedent）。

---

## 3. 每个 queue producer 是否携带 scope

| producer | 202 传递路径 | 结果 |
|---|---|---|
| read（`_wsPendingReads`） | `_execWsOps` → `_rEntry=Object.assign({…},_sc)` | ✅ 带 `friendId`/`threadId` |
| op-feedback（`_wsPendingOpFeedback`） | `_execWsOps` → `_pushOpFeedback(text)`（单一入口，覆盖 6 处） | ✅ |
| run-output（`_wsPendingRunOutputs`） | `_rCtx`(+`_sc`) → run 卡片 ctx → `_wsQueueRunOutput` → 条目 | ✅（auto 与卡片两条路径同源） |
| tool-result（`_ibToolPendingResults`） | `_ibExecToolOp(...,_sc)` → Inner → 4 处 push；卡片路径 `_csc` | ✅ |
| phantom（走 op-feedback） | `_wsCheckPhantom(...,{friendId,threadId})`（群 / 1:1 流式 / 非流式三处调用点） | ✅ |
| 续写增量（`continueTruncatedMsg`） | 补传 `ictx={source:'chat',friendId:m.friendId,threadId:m.threadId}` | ✅（原先无 ictx） |
| guard breaker（熔断） | `site-operations.js:316` 作用域内无会话 | **intentionally unscoped**（不带任何 scope 字段） |
| 测试/诊断入口（`_processWsResponse` 等） | 调用方无 ictx | **intentionally unscoped** |

规则实现（P30-1 §6）：`_wsScopeFragment` 只在 `friendId` 为非空字符串时返回 `{friendId,threadId}`（`threadId`
缺省为 `null`）；否则返回 `null` ⇒ 条目**零 scope 字段**。**未**从 actor/senderName 推导，**未**复制
`conversationIdOf` 逻辑。

---

## 4. 每个 consumer 是否 KEEP mismatch

| consumer | 过滤 | 不匹配项 |
|---|---|---|
| 群聊注入（`_buildGroupChatContext`） | `_gInjMine` = **scope（WHERE）∧ actor（WHO）** | KEEP（返回 false ⇒ 留在队列） |
| 1:1 上下文（`_buildSingleChatContext`） | `_ibWsScopeFilter(opts.friendId‖cfg.id, opts.threadId)` | KEEP |
| tool continuation（`_wsToolContinueInner`） | `_ibWsScopeFilter(o.friendId,o.threadId)` | KEEP |
| UI 读取提示 / `chat-context-signals` | 只读 length/text（非消费路径） | 不涉及（未改） |
| 图片注入 / blog 注入 | **本阶段明确排除** | 不变（follow-up） |

KEEP 由既有 take/keep 机制实现（`_getWs*Injection(filterFn)` 已具备"匹配移出、非匹配保留"），
**未**新增 `splice` / 清空 / consume-then-filter。队列 FIFO 顺序不变；不匹配项数量不变。

---

## 5. 是否修改 P24 / P23 / DB

**NO / NO / NO**

| 边界 | 证据 |
|---|---|
| P24 identity | `group-runtime-core.js` 未被触碰（mtime 09-19）；planner/memberTurnId/targeting/recent/SILENT/DEFER 均未改 |
| P23 delivery | 五核心未被触碰；只复用 `chat-core.conversationIdOf` 的既有 adapter `_ibConvId` |
| DB | `DB_VER=24`；无 schema/store/migration（队列全 runtime-only） |

---

## 6. 测试结果

| 套件 | 结果 |
|---|---|
| **`tests/test_workspace_conversation_scope.js`（新增）** | **30 PASS**（C1 跨会话不可见且 KEEP · C2 归属会话可见并移除 · C3 错误会话重复读取队列不变 · C4 同 actor 不同 thread 隔离 · C5 legacy 保持旧行为 · C6 intentionally unscoped 首轮兜底 · C7 见下 · C8 派生唯一来源/无本地派生/无 manager + producer 形状含 unscoped 反例） |
| `tests/test_workspace_actor_identity.js`（C7） | **50 PASS**（7 条源码形状守卫按新形状重写，行为断言不变） |
| `tests/test_identity_read_path_closure.js`（C7） | **54 PASS** |
| `tests/test_workspace_smoke.js` | PASS |
| `tests/test_group_speaker_identity.js` | 50 PASS |
| `tests/test_group_turn_identity.js` | 99 PASS |
| `tests/test_group_participation_integration.js` | 122 PASS |
| `tests/test_p11_3d_tool_execution_guard.js`（tool 传播改动） | ALL PASS |
| `tests/test_moments_phase4_smoke.js`（`_processWsResponse` 老签名路径） | PASS |

**未跑 full quick**（未改 shared schema / DB version / P24 contract）。

---

## 7. git diff 范围

本阶段（P30-2）改动文件 **恰好**：

```
assets/js/workspace.js
assets/js/workspace/run.js
assets/js/site-operations.js
assets/js/communication.js        ← 仅 consumer 注入点 + `_wsCheckPhantom` 透传 + filter 导出
tests/test_workspace_conversation_scope.js   （新增）
tests/test_workspace_actor_identity.js       （守卫形状更新）
tests/test-all.js                            （登记）
docs/P30-2-WORKSPACE-CONVERSATION-SCOPE-IMPLEMENTATION.md（本文档）
```

禁止清单文件（`group-runtime-core.js` / P23 五核心 / `memory.js` / `middle-brain*` / `autonomy-core.js` /
`agent-runtime.js` / `core.js`）**mtime 全部早于本阶段**（09-13 … 09-19）⇒ 零触碰。
临时诊断脚本已删除；`git status` 无残留。未 stage、未 commit。

---

## 8. 遗留 follow-up（本阶段明确排除）

| 项 | 阶段 |
|---|---|
| blog `_blogPendingReads` / `_blogReadFeedback`（N1：无 actor、无 scope，用户点击"允许"产生） | 独立契约（P30-1 §13：SAME PRINCIPLE / DIFFERENT CONTRACT） |
| `_ibImageDrain` / `_ibToolDrainImages`（R3：裸 dataUrl、无 actor/scope、`splice(0)`） | Media Attribution / Queue Scope |
| `projectFiles.lastModifiedBy`（R4：persisted display 名参与导入避让） | Workspace File Provenance |

---

## 9. 实施中被测试抓到并修正的两处问题（记录）

1. **`_targetFriend is not defined`**：初版把 1:1 的 scope filter 写成 `_ibWsScopeFilter(_targetFriend,_targetThread)`，
   但该表达式位于 `_buildSingleChatContext(cfg,opts)` 作用域（无 `_targetFriend`）⇒ 1:1 上下文构建抛错、
   该轮无 provider 请求。已改为由调用方透传 `opts.friendId`（1:1 调用点补 `friendId:_targetFriend`），
   兜底 `cfg.id`；工具续轮改用 `o.friendId/o.threadId`。
2. **filter 未导出**：`_ibWsScopeFilter` 与 `_ibConvId` 同层但未 `window` 暴露（communication.js 的函数不是自动全局），
   测试的 readiness 断言因此失败。已补 `window._ibWsScopeFilter=_ibWsScopeFilter;`（与 `_ibConvId` 同一导出块）。
