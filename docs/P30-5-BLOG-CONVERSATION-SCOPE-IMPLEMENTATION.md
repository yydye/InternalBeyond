# P30-5 Blog Conversation Scope Implementation

阶段性质：**IMPLEMENTATION / FOCUSED REGRESSION**（按 P30-4 冻结契约实施，未重开契约）。

---

## 1. State

**P30-5 State: PASS — BLOG CONVERSATION SCOPE IMPLEMENTED**

**Blog Conversation Scope IMPLEMENTED**。推荐下一阶段：**P30-C · Conversation Scope Closure**。

---

## 2. Modified Files

| 文件 | 类型 | 内容 |
|---|---|---|
| `assets/js/workspace.js` | production | `_execBlogReadOps(ops,scopeSrc)` 捕获 request-origin scope 并写入 registry / feedback；`_brAllow`/`_brDeny` 只从 registry 继承 scope；`_brAllow` 自动续答按 canonical conversationId 判定；`_getBlogReadInjection(scopeFilter)` 两队列各自 take/keep + legacy string 渲染 |
| `assets/js/communication.js` | production | 两处 producer 调用点传 request-origin scope；两处 consumer 调用点传 `_ibWsScopeFilter(...)` |
| `tests/test_blog_conversation_scope.js` | 新增测试 | C1–C16（52 checks） |
| `tests/test-all.js` | 仅登记 | browser 组新增一条 |
| `docs/P30-5-BLOG-CONVERSATION-SCOPE-IMPLEMENTATION.md` | 新增文档 | 本报告 |

**未修改**：`group-runtime-core.js` · P23 五核心（含 `delivery-runtime.js`）· `memory.js` · `middle-brain*` ·
`autonomy-core.js` · `agent-runtime.js` · `core.js`（`DB_VER`/schema）。

---

## 3. Request-Origin Capture

```js
async function _execBlogReadOps(ops,scopeSrc){        // workspace.js:1154
  var _bsc=_wsScopeFragment(scopeSrc);                // 复用 P30-2 的归一（friendId 非空才成 scope）
  ...
  _blogReqReg[uid]=Object.assign({state:'pending',…},_bsc);   // :1172 与 request 同时落库
```

调用点（`communication.js`，即 `<blog_read>` 产生的那一轮）：

```
:3185  _execBlogReadOps(_bp.ops , {friendId:_targetFriend, threadId:_targetThread})   // 1:1 流式
:3298  _execBlogReadOps(_bpn.ops, {friendId:_targetFriend, threadId:_targetThread})   // 1:1 非流式
```

`_targetFriend`/`_targetThread` 是**该回合开始时捕获的会话**（`sendChatMessage` 顶部），
不是之后的 UI active 状态 ⇒ 满足 P30-4 §6 的"producer origin 才是事实"。

---

## 4. Registry Scope

`_blogReqReg[uid]` 既有字段不变（`state/postId/title/from/chars/charCount/total/tokens`），
additive 增加 `friendId` / `threadId`。**未新增** `conversationId`；
registry 生命周期未改（无 cleanup；跨会话切换存活，P30-4 §7 结论保持）。

---

## 5. Allow Handoff

```js
var _rsc=_wsScopeFragment(req);                       // ← 只来自 registry（request origin）
_blogPendingReads.push(Object.assign({title,content,range,total},_rsc));
```

F6（已不可读）feedback 同样带 `_rsc`。**未使用** click-time `activeFriendId`/`activeThreadId` 作为 ownership
（`_tf=activeFriendId` 仍只用于"对方正在回复中"的并发守卫）。

---

## 6. Deny Handoff

```js
_blogReadFeedback.push(Object.assign({text:'用户拒绝了阅读…'},_wsScopeFragment(req)));
```

---

## 7. Pending Read Shape

```js
{ title, content, range, total, friendId?, threadId? }
```

（scope 缺省只可能来自 legacy/test registry entry ⇒ unscoped，保持既有 fallback。）

---

## 8. Feedback Shape

生产写入**全部对象化**：`{ text, friendId?, threadId? }`。

| 位置 | 场景 |
|---|---|
| `_execBlogReadOps` `:1167` | from 越界（F5） |
| `:1175` | 多篇同名（F4） |
| `:1178` | 不存在（F3） |
| `_brAllow` `:1225` | 已不可读（F6） |
| `_brDeny` `:1262` | 用户拒绝（F2） |

**不再生产 bare string**。

---

## 9. Consumer Filtering

```js
function _getBlogReadInjection(scopeFilter){          // workspace.js:1273
  var _flt=(typeof scopeFilter==='function')?scopeFilter:null;   // 缺省 ⇒ 旧 take-all（测试/诊断）
  … 两个队列各自 _take(list) ⇒ {take,keep} …
}
```

调用点：`communication.js:1730`（1:1 context）传 `_wsScopeMine`；`:4465`（tool continuation）传 `_scMine`
（两者都是 `_ibWsScopeFilter(friendId,threadId)`，与 P30-2 Workspace 同一谓词，未改其语义）。
群聊不调用（既有契约保持）。

---

## 10. Mismatch KEEP

`_blogPendingReads=_p.keep;` / `_blogReadFeedback=_f.keep;` —— 非匹配项留在原队列；
**已删除**原有的 `queue=[]` 无条件清空（源码守卫 `S.noUnconditionalClearAll`，仅允许声明处 `var X=[];`）。
最高 invariant「A consumer must never remove B's scoped Blog item」由 C1/C3/C4 实测锁定。

---

## 11. FIFO

take/keep 都是**稳定顺序遍历**（`forEach` 顺序 push），不 sort / 不 reverse / 不建 per-conversation map。
C12 实测：`[A1,B1,A2]` + A 会话消费 ⇒ ctx 中 `A1` 在 `A2` 之前，keep 结果 = `['B1']`。

---

## 12. Legacy Compatibility

* `string` 反馈：读侧 `typeof f==='string'?f:String((f&&f.text)||'')` ⇒ **不崩、不输出 `[object Object]`**，
  且谓词对字符串放行（`it.friendId` 为 undefined ⇒ unscoped ⇒ 旧 fallback）⇒ C9 实测可消费。
* legacy pending-read（无 scope）：谓词放行 ⇒ 保持既有行为。
* runtime-only ⇒ **无 migration**。

---

## 13. Auto Continuation

```js
var _sf=window._ibWsScopeFilter(activeFriendId,activeThreadId);   // canonical conversationId 比较
_sameConv=!!_sf&&!!_sf(_rsc||{});
if(!_sameConv)return;                                            // 抑制：item 留在队列等 origin 会话
```

* origin == 活动会话 ⇒ 保留既有自动续答（C10 实测 `calls===1`）；
* origin ≠ 活动会话（含同角色不同 thread）⇒ **抑制**（C1/C3 实测 `calls===0`），item 仍 scoped 保留；
* 谓词不可用 ⇒ 抑制（fail closed）；**绝不**把续答发往 click-time 会话，**绝不**改 scope，**绝不**切 UI。

---

## 14. Conversation Switch

真实 probe（C1/C2）：A 发起 request → 切到 B → Allow/Deny ⇒ registry scope = A、pending/feedback scope = A；
B 看不到、不消费、队列不减少；A 的下一条消息看到并消费。**authorization 改变 access result，不改变 ownership**。

---

## 15. Same Actor Different Thread

真实 probe（C3）：B/thread-X 发起 → 切 B/thread-Y → Allow ⇒ item 为 `(B, X)`；
Y 看不到、队列保持 1；X 看到并消费（队列归零）。证明 **friendId alone is insufficient**。

---

## 16. Real Probe

`tests/test_blog_conversation_scope.js` 内含真实浏览器差分 probe（真实页面 + mock provider +
真实 `_execBlogReadOps`/`_brAllow`/`_brDeny`/`_getBlogReadInjection` + 捕获真实 provider 请求）：

```
registry scope = A           ✓ (C1.registryCapturedOriginScope)
pending item scope = A       ✓ (C1.pendingReadInheritsOriginScope)
B does not see / drain       ✓ (C1.B_cannotSee / C4.*)
A sees / drains              ✓ (C5.*)
auto continuation suppressed ✓ (C10 前半) / preserved ✓ (C10 后半)
same actor thread isolation  ✓ (C3.*)
```

---

## 17. Tests

| 套件 | 结果 |
|---|---|
| **`tests/test_blog_conversation_scope.js`（新增）** | **52 PASS** |
| `tests/test_workspace_conversation_scope.js`（C13） | 30 PASS |
| `tests/test_workspace_actor_identity.js`（C14） | 50 PASS |
| `tests/test_identity_read_path_closure.js`（C14） | 54 PASS |
| `tests/test_workspace_smoke.js`（直接相关 smoke） | PASS |
| `tests/test_group_speaker_identity.js`（communication.js 触达） | 50 PASS |
| `tests/test_group_turn_identity.js`（communication.js 触达） | 99 PASS |

未跑 `test-all --quick`（未改 shared canonical infrastructure）。

---

## 18. Frozen Boundary Verification

| 边界 | 结果 | 证据 |
|---|---|---|
| P29 identity | **未改** | 两套件全绿；blog 未引入 actorId/speakerId |
| P23（含 delivery-runtime） | **未改** | mtime 09-18；仅复用 `conversationIdOf` 既有 adapter |
| P24 | **未改** | `group-runtime-core.js` mtime 09-19；planVersion=3 / memberTurnId 公式守卫绿 |
| P30-1/P30-2 Workspace contract | **未改** | `_ibWsScopeFilter` byte-semantic 未变（仅被 blog 侧复用）；workspace 套件 30 PASS |
| R3 image / R4 file provenance | **未处理** | 未触碰 `_ibImageDrain` / `lastModifiedBy` |
| DB | **未改** | `DB_VER=24`（源码 + 运行期）；无 createObjectStore |
| 新架构 | **无** | 无 Manager/Bus/Store/Session（源码守卫 `S.noNewArchitecture`） |

---

## 19. Remaining Follow-ups

| 项 | 说明 |
|---|---|
| deleted/invalid origin conversation | P30-4 §18 的 **EDGE_POLICY_DEFERRED** 保持：本阶段只保证"不把 scope 重指向当前活动会话"（origin 不存在时 item 不会被任何会话消费，静静留在队列） |
| R3 media attribution | 独立阶段（Media Attribution / Queue Scope） |
| R4 file provenance | 独立阶段（Workspace File Provenance） |
| `_ibWsScopeFilter` 命名 | 语义上是 generic conversation-scope predicate；可选后续 rename/generalize（非必需） |

---

## 20. Git / Worktree

| 项 | 结果 |
|---|---|
| production 改动 | **仅 2 个文件**：`assets/js/workspace.js` · `assets/js/communication.js`（= P30-5 §2 允许清单） |
| 其它 production | 零触碰（禁止清单 mtime 全为 09-13…09-19） |
| 测试/文档 | `tests/test_blog_conversation_scope.js`（新）· `tests/test-all.js`（登记）· 本文件 |
| 临时文件 | 无（本阶段未使用临时 probe 脚本；`git status` 无 `tmp_*` 残留） |
| git 操作 | 未使用 `checkout --` / `restore` / `reset --hard` / `clean` / stash；未 stage、未 commit |

---

## 附 · Required Final Answers（Q1–Q30）

1. **`_execBlogReadOps` 是否捕获 request-origin scope？** 是（`:1154` 接收 `scopeSrc`，`:1172` 写入 registry）。
2. **`_blogReqReg` 是否保存 friendId/threadId？** 是（additive）。
3. **所有 immediate feedback 是否继承 origin scope？** 是（from 越界 / 多篇 / 不存在三处均带 `,_bsc`）。
4. **`_brAllow` 是否只从 registry 继承 scope？** 是（`_wsScopeFragment(req)`）。
5. **`_brDeny` 是否只从 registry 继承 scope？** 是。
6. **是否仍有 click-time active conversation 参与 ownership？** 否（仅用于并发守卫；比较用于自动续答的"是否同会话"，不是 ownership 赋值）。
7. **`_blogPendingReads` 是否 scoped？** 是。
8. **`_blogReadFeedback` production writes 是否全部对象化？** 是（5 处）。
9. **legacy string 是否仍兼容？** 是（可消费、原文渲染）。
10. **是否存在 `[object Object]` 回归？** 否（C9 实测）。
11. **`_getBlogReadInjection` 是否按 current conversation filter？** 是（两个调用点都传 `_ibWsScopeFilter`）。
12. **mismatch 是否 KEEP？** 是。
13. **错误 consumer 是否完全不能减少其它 scope queue？** 是（C1/C3/C4：队列长度不变）。
14. **两个 queue 是否独立过滤？** 是（C11：A 的 read 命中不清空 B 的 feedback）。
15. **FIFO 是否保持？** 是（C12）。
16. **A request → B Allow 是否仍归 A？** 是（C1）。
17. **A request → B Deny 是否仍归 A？** 是（C2）。
18. **同 actor 不同 thread 是否隔离？** 是（C3）。
19. **origin 非 active 时是否抑制 auto continuation？** 是（C10 前半）。
20. **origin active 时原 auto continuation 是否保留？** 是（C10 后半）。
21. **是否修改 P30-2 Workspace contract？** 否。
22. **是否修改 P29？** 否。
23. **是否修改 P23？** 否。
24. **是否修改 P24？** 否。
25. **是否处理 R3 image？** 否（排除）。
26. **是否处理 R4 file provenance？** 否（排除）。
27. **是否新增 Manager/Bus/Store？** 否。
28. **DB_VER 是否仍为 24？** 是。
29. **focused tests 是否全部 PASS？** 是（52 + 30 + 50 + 54 + smoke + group 50/99）。
30. **P30-5 是否 implementation complete？** 是。

---

## Final State

**P30-5 State: PASS — BLOG CONVERSATION SCOPE IMPLEMENTED**

**Blog Conversation Scope**
**IMPLEMENTED**
