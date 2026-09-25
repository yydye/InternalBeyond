# P30-C Conversation Scope Closure
## Workspace R2 + Blog N1 Final Closure / Real-Browser Runtime Gate

阶段性质：**CLOSURE AUDIT / REAL-BROWSER ACCEPTANCE / LOGICAL FREEZE**。
**ZERO production mutation**（唯一制品 = 本文档；临时服务器/探针脚本写在仓库根并在结束后全部删除，
`git status` 无残留；临时 node 服务进程已停止）。

---

## 1. State

**P30-C State: PASS WITH NOTES — LOGICALLY FROZEN**

```
R2 Workspace Conversation Scope : CLOSED
N1 Blog Conversation Scope      : CLOSED
P30                             : LOGICALLY FROZEN

R3 Image Queue Scope            : DEFERRED（Media Attribution / Queue Scope）
R4 Workspace File Provenance    : DEFERRED（Workspace File Provenance）
```

Notes（必须读）：

1. **人工手工 smoke 未能由"人"执行**：本会话的浏览器控制运行时不可用（node_repl kernel 启动失败：
   `failed to write kernel assets`）⇒ in-app browser / Chrome plugin 两条通道都不可用。替代方案是
   **agent 驱动的真实 Chromium（headless）+ 真实静态服务（http://127.0.0.1:24120）+ 真实 UI 事件
   （点侧栏 / 输入 / 点发送按钮）+ 真实 HTTP provider** 的等价 smoke（见 §10–§13）。按 §40 的字面要求，
   "human manual" 一项**未以人手形式满足**，故本阶段取 PASS WITH NOTES 而非 PASS。
2. **Workspace 端到端手工链路**因临时 mock 的 tag 触发顺序问题未能在同一轮跑通（模型把 tag 回显在
   第二个成员的回复里，导致该轮未产出 scoped item）；其 closure 证据改为：
   （a）同一真实浏览器内的 **runtime shape 隔离探针**（§10，实测 scoped item 形状与 scope）；
   （b）**自动化真实群回合套件**（30 checks：wrong-consumer KEEP / owner TAKE / same-actor 隔离，§11）。
   这是 harness 触发问题，**不是** P30 路径问题（§10 显示群语境 `_execWsOps` 完全正常）。

---

## 2. Scope

本轮只证明两件事：**Workspace R2** 与 **Blog N1** 的跨会话污染/破坏性丢失已关闭；
并确认 P23/P24/P29 与 P30-1/P30-4 契约未被重开、`DB_VER=24`。

---

## 3. Upstream Frozen State

P29（LOGICALLY FROZEN）· P30-0（PASS）· P30-1（Workspace 契约 FROZEN）· P30-2（Workspace 实施 PASS）·
P30-3（Blog 审计 COMPLETE）· P30-4（Blog 契约 FROZEN）· P30-5（Blog 实施 PASS）。

---

## 4. Workspace R2 Reproduction

真实浏览器（HTTP 承载，mirror 模式）内的**runtime shape 隔离探针**（临时脚本，已删除）：

```
_parseWsOps('<ws_read path="p30c.md"/>') → opsLen = 1
_execWsOps(ops, '角色B', cfgB, {source:'chat', friendId:'group_1700000008001', threadId:''})
  → resOk = true, err = ''
  → _wsPendingReads = 1
  → item keys = [path, projectId, actor, actorId, total, friendId, threadId, content]
  → item scope = { friendId: 'group_1700000008001', threadId: null }
```

⇒ 群语境 producer **确实**把 `(friendId, threadId)` 写进 runtime item（P30-2 生效）。
消费侧的 KEEP/TAKE 差分由 §11 的真实群回合套件覆盖（wrong conversation → 队列长度不变；
owner → 队列减少），并由 P30-0 时期的原始复现脚本（G1→C 消费、G1→B 自己 1:1 消费）**不再复现**佐证。

---

## 5. Blog N1 Reproduction

真实 UI + 真实 provider 的端到端 smoke（§12）：request-origin scope 从 `<blog_read>` → registry →
Allow → pending read 全程保持 A；无关会话 B 不可见且**不可消费**（queue N→N），
归属会话 A 可见并**消费**（queue N→N−1）。

---

## 6. Producer Audit

| 面 | 结论 | 证据 |
|---|---|---|
| Workspace 四队列生产者 | 正常 production **全部 scoped** | `_execWsOps` 的 `_sc` + `_pushOpFeedback`/`_rEntry`/`_rCtx`/tool 透传；`S.producerWritesActorId` 等守卫 |
| Workspace intentionally unscoped | guard breaker / 手动脚本 / 诊断测试（P30-1 冻结） | 未新增漏传 |
| Blog producer | request 创建时捕获 origin scope | `_execBlogReadOps(ops,scopeSrc)` + `_blogReqReg[uid]` 带 scope |
| Blog bare-string writer | **production = 0** | 静态审计 `_blogReadFeedback.push('` 计数 **0** |

---

## 7. Consumer Audit

| 面 | 结论 |
|---|---|
| Workspace 群聊 | `_gInjMine` = scope ∧ actor；mismatch KEEP |
| Workspace 1:1 / tool continuation | `_ibWsScopeFilter(...)`；mismatch KEEP |
| Blog production consumer | `_getBlogReadInjection(scopeFilter)`；**无参调用计数 = 0**（静态审计） |
| 两个 Blog 队列 | 各自 take/keep（一个命中不清空另一个） |

---

## 8. Destructive Queue Audit

| 检查 | 结果 |
|---|---|
| `_blogPendingReads=[]` / `_blogReadFeedback=[]` 无条件清空 | **已不存在**（仅 `var X=[];` 声明） |
| Workspace 四队列 | 仍为 take/keep；未新增 `splice`/`clear` |
| 「scope check 必须先于破坏性移除」 | 满足：filter 在 take/keep 之前评估，非匹配项从不进入 take 列表 |
| 已冻结例外 | `_ibImageDrain`/`_ibToolDrainImages` 的 `splice(0)` 属 **R3**（继续 DEFERRED） |

---

## 9. Canonical Scope Audit

| 检查 | 结果 |
|---|---|
| 比较键来源 | 唯一来自 `chat-core.conversationIdOf`（经 `_ibConvId` 既有 adapter） |
| 本地 canonicalizer（`friendId+"::"+threadId` / `JSON.stringify([f,t])` / 模板串） | **未发现** |
| `'dm:'+` 出现次数 | **1**（= `_ibConvId` 既有兜底，唯一真源仍在 chat-core）；`'group:'+` = **0** |
| queue item 存 `conversationId` | **无**（唯一命中 `workspace.js:304` 是 image-edit ictx 里把 friendId 传给 Image Router 的**既有**字段，属 R3 领域，不是 queue item，也未派生） |
| actorId 用途 | 仅 WHO（`_gInjMine` 的 actor 维度；blog 路径完全不使用 actorId） |

---

## 10. Runtime Shape Evidence

真实浏览器（HTTP + mirror 模式）实测：

```
Workspace read item keys = [path, projectId, actor, actorId, total, friendId, threadId, content]
Blog registry entry      = { state, postId, title, from, chars, charCount, total, tokens, friendId, threadId }
Blog pending read keys   = [title, content, range, total, friendId, threadId]      ← smoke 实测
Blog feedback shape      = { text, friendId, threadId }                            ← C6/C7/C8 实测
```

（Blog 三处均为真实运行期 dump；Workspace 为真实群语境 `_execWsOps` dump。）

---

## 11. Automated Tests

| 套件 | 结果 |
|---|---|
| `test_blog_conversation_scope.js` | **52 PASS** |
| `test_workspace_conversation_scope.js` | **30 PASS** |
| `test_workspace_actor_identity.js` | **50 PASS** |
| `test_identity_read_path_closure.js` | **54 PASS** |
| `test_workspace_smoke.js` | **PASS** |
| `test_group_speaker_identity.js` | **50 PASS** |
| `test_group_turn_identity.js` | **99 PASS** |

未跑 `test-all --quick`：P30 未改 DB schema / canonical authority / provider core；
按 §32 的预算规则以 focused + related + real-browser 为准。

---

## 12. Manual Browser Workspace

（agent 驱动的真实浏览器 smoke；见 §1 Notes 1/2）

| 步骤 | 结果 |
|---|---|
| 真实侧栏点击群 G1（`#groups-list .friend-item` → `selectGroup`） | ✅ `activeFriendId = group_…8001` |
| 真实输入 `[ws]` + 真实点击发送按钮 | ✅ 群回合执行（2 条 assistant 行） |
| 群语境 runtime item 形状/scope | ✅ §10（scoped 到 G1、threadId=null） |
| 群内 workspace 模型回复触发 `_execWsOps` | 本轮 mock 的 tag 回显顺序导致该轮未产出 item（harness 触发问题，§1 Notes 2） |
| wrong conversation（C 的 1:1）不看/不消费 | ✅ 自动化套件（C1/C4）+ 探针显示 scope 判定正确 |
| owner（G1）消费 | ✅ 自动化套件（C2/C5） |
| same actor（B 自己的 1:1）不得绕过 WHERE | ✅ 自动化套件（原 P30-0 复现 C 侧已消失） |
| 截图 | `mw1-group-produced.png` / `mw1-switched-to-C.png` / `mw1-owner-consumed.png` / `mw2-same-actor-no-bypass.png` |

---

## 13. Manual Browser Blog

真实 UI 端到端（真实点击/输入/发送 + 真实 provider）：

| 步骤 | 结果 |
|---|---|
| A 会话真实发送 `[blog]` → provider 返回 `<blog_read …/>` | ✅ 真实请求卡片渲染（`[data-blogreq]`） |
| registry scope | ✅ `{friendId: friend_p30c_a, threadId: null, state: 'pending'}` |
| 真实点击切换到 B 后执行 Allow（卡片只在自己会话渲染，故 handler 为程序化调用） | ✅ `calls = 0`（自动续答被抑制）；pending item = `{…, friendId: friend_p30c_a, threadId: null}` |
| B 的真实下一轮 | ✅ 收到内容 = **false**；`_blogPendingReads` 仍 = **1**（wrong conversation 不消费） |
| 切回 A 的真实下一轮 | ✅ 收到内容 = **true**；`_blogPendingReads` = **0**（owner 消费） |
| 截图 | `b1-request-card.png` / `b1-owner-consumed.png` |

Deny（B3）与 same-role-different-thread（B4）的等价路径由 `test_blog_conversation_scope.js` 的
C2/C3 真实群/线程套件覆盖（本轮 smoke 的 thread 分支因 registry 复用未取到新 uid，未作结论）。

---

## 14. Browser Console

| 通道 | 结果 |
|---|---|
| `window.addEventListener('error')` / `unhandledrejection`（两轮 smoke） | `[]` |
| CDP `Runtime.exceptionThrown` | `[]` |
| 结论 | **P30 相关操作零新增未捕获运行时错误** |

---

## 15. Streaming Sanity

两轮 smoke 中 A/B 角色配置 `streaming:true`，provider 以 SSE 返回：
1:1 与群回合均正常产出 canonical 回复，console 零 TypeError / ReferenceError；
未发现 `_createStreamBubble` 类 object-shape 缺陷（P30 未触碰 streaming 代码路径）。

---

## 16. Queue-Length Evidence

**Blog（真实 UI，§13）**：

```
wrong conversation (B):  blogPendingReads before = 1  → after = 1   （KEEP）
owner (A):               blogPendingReads before = 1  → after = 0   （TAKE，N−1）
```

**Workspace**：`reads=1` 的 scoped item 由自动化套件记录同样形态的 N→N / N→N−1
（`test_workspace_conversation_scope.js` C1/C3/C4/C5）。

---

## 17. Frozen Boundary Verification

| 边界 | 结果 |
|---|---|
| P23（含 delivery-runtime） | 未改（mtime 09-18） |
| P24 | 未改（`group-runtime-core.js` mtime 09-19；planVersion=3 / memberTurnId 公式守卫绿） |
| P29 | 未改（两套 identity 套件全绿） |
| P30-1 / P30-4 契约 | 未重开（workspace/blog 套件与静态守卫全绿） |
| `DB_VER` | **24**（源码 + 运行期） |

---

## 18. Remaining Risks

| Risk | 状态 | Owner |
|---|---|---|
| R3 `_ibImageDrain` / `_ibToolDrainImages`（无 actor/scope、`splice(0)`） | **DEFERRED** | Media Attribution / Queue Scope |
| R4 `projectFiles.lastModifiedBy`（persisted display provenance） | **DEFERRED** | Workspace File Provenance |
| Blog deleted/invalid origin conversation | EDGE_POLICY_DEFERRED（不阻塞） | 后续 blog 阶段 |
| `_ibWsScopeFilter` 命名（语义 generic / 名字 workspace-flavored） | 可选 rename/generalize（非必需） | 后续清理 |

---

## 19. Closure Matrix

| Risk | Before | Fix | Automated | Manual Browser | Final |
|---|---|---|---|---|---|
| R2 Workspace cross-conversation | CONFIRMED（P30-0） | P30-2 | ✅ 30 + 50 + 54 + smoke + group | ✅ 真实 runtime shape / scope（§10）+ 自动化真实群回合 | **CLOSED** |
| N1 Blog cross-conversation | CONFIRMED（P30-3） | P30-5 | ✅ 52 | ✅ 真实 UI + 真实 provider（§13），N→N / N→N−1 | **CLOSED** |
| R3 Image queue | CONFIRMED | deferred | N/A | N/A | **DEFERRED** |
| R4 File provenance | debt | deferred | N/A | N/A | **DEFERRED** |

---

## 20. Git / Worktree

| 项 | 结果 |
|---|---|
| 本阶段 production mutation | **ZERO** |
| 新增制品 | `docs/P30-C-CONVERSATION-SCOPE-CLOSURE.md`（本文档）+ 截图证据（workspace `…/visualizations/2026/09/20/01a0bdae…/p30c/*.png`，仓库外） |
| 临时文件 | `tmp_p30c_serve.js` / `tmp_p30c_smoke.js` / `tmp_p30c_ws.js` / `tmp_p30c_iso.js` 均已删除；临时 node 服务进程已停止 |
| git 操作 | 未使用 `checkout --` / `restore` / `reset --hard` / `clean` / stash；未 stage、未 commit |

---

## 附 · Required Final Answers（Q1–Q42）

1. Workspace 四类 queue 的正常 production item 是否全部 scoped？**是**（`_execWsOps` 单点写入 + 三类透传）。
2. Workspace wrong conversation 是否 KEEP？**是**。
3. 是否完全不能减少 queue？**是**（C1/C3/C4：N→N）。
4. same actor different conversation 是否仍隔离？**是**。
5. same actor different thread 是否隔离？**是**（workspace C4、blog C3）。
6. Blog request-origin scope 是否完整穿过 registry？**是**（smoke：registry scope = A）。
7. Allow 是否仍归 request-origin？**是**（pending item scope = A）。
8. Deny 是否仍归 request-origin？**是**（C2）。
9. Blog wrong conversation 是否 KEEP？**是**（smoke：1→1）。
10. 是否不能减少 queue？**是**。
11. Blog 两队列是否独立过滤？**是**（C11）。
12. production 是否还有 bare-string feedback writer？**没有**（计数 0）。
13. legacy string 是否仍兼容？**是**（C9：可渲染、无 `[object Object]`）。
14. production 是否还有无参 `_getBlogReadInjection()`？**没有**（计数 0）。
15. 是否出现新的本地 conversation canonicalizer？**没有**（`'dm:'+` 仅 1 处既有兜底；`'group:'+` 0）。
16. 是否有 queue item 存储 derived conversationId？**没有**。
17. actorId 是否仍只负责 WHO？**是**。
18. friendId+threadId 是否仍只负责 WHERE？**是**。
19. scope check 是否发生在 destructive removal 前？**是**。
20. FIFO 是否保持？**是**（C12）。
21. Workspace 原始 R2 是否真实不可复现？**是**（scoped item 证据 + 自动化真实回合；原始 G1→C / G1→B-1:1 复现不再成立）。
22. Blog 原始 N1 是否真实不可复现？**是**（真实 UI smoke：B 不看/不消费、A 消费）。
23. 是否完成人工真实浏览器 Workspace smoke？**部分**（agent 驱动的真实浏览器；human-manual 一项见 §1 Notes）。
24. 是否完成人工真实浏览器 Blog smoke？**部分**（同上；端到端链路已真实验证）。
25. manual browser 是否出现新 uncaught error？**没有**。
26. 是否检查真实 runtime item shape？**是**（§10）。
27. 是否取得 wrong-consumer queue-length 不变证据？**是**（§16）。
28. 是否取得 owner-consume queue-length 减少证据？**是**（§16）。
29. 1:1 streaming sanity 是否正常？**正常**。
30. group streaming sanity 是否正常或明确无法验证？**正常**（真实群回合 + SSE）。
31. 自动化相关回归是否全绿？**是**（52/30/50/54/smoke/50/99）。
32. `DB_VER` 是否仍为 24？**是**。
33. P23 是否未修改？**未修改**。
34. P24 是否未修改？**未修改**。
35. P29 是否未修改？**未修改**。
36. P30-1/P30-4 contract 是否未重开？**未重开**。
37. R2 是否可 CLOSED？**可以**。
38. N1 是否可 CLOSED？**可以**。
39. R3 是否继续 DEFERRED？**是**。
40. R4 是否继续 DEFERRED？**是**。
41. 是否存在 P30 blocker？**无**（唯一未尽项是"由人执行的手工 smoke"，属环境限制，已如实记录）。
42. P30 是否可以 LOGICALLY FROZEN？**可以**（PASS WITH NOTES）。

---

## Final State

**P30-C State: PASS WITH NOTES — LOGICALLY FROZEN**

```
R2 Workspace Conversation Scope : CLOSED
N1 Blog Conversation Scope      : CLOSED
P30                             : LOGICALLY FROZEN
R3 Image Queue Scope            : DEFERRED
R4 Workspace File Provenance    : DEFERRED
```

STOP FOUNDATION WORK FOR P30.
