# P29-3 Workspace Actor Identity Implementation
## Canonical Attribution Preservation

阶段性质：**IMPLEMENTATION / FOCUSED IDENTITY FIX / RUNTIME OBJECT ENRICHMENT**。
严格按 P29-2 冻结决策实施（P29-2 State: PASS — IMPLEMENTATION APPROVED），未重开任何契约决定。

---

## 1. State

**P29-3 State: PASS WITH NOTES — IMPLEMENTATION COMPLETE**

```
Production files changed:
  assets/js/workspace.js
  assets/js/workspace/run.js
  assets/js/site-operations.js
  assets/js/communication.js（仅 reader `_gInjMine` + 3 处 `_wsCheckPhantom` 透传）

Tests:
  新增 tests/test_workspace_actor_identity.js（49 checks 全绿）
  test_workspace_smoke.js ✔ · test_identity_read_path_closure.js 54 ✔ ·
  test_group_speaker_identity.js 50 ✔ · test_group_turn_identity.js 99 ✔ ·
  test_p11_3d_tool_execution_guard.js ALL PASS ✔（touch 了 tool 传播）·
  test_image_router_smoke.js ✔ · test_moments_phase4_smoke.js ✔（走 `_processWsResponse` 的字符串 cfg 路径）

Remaining debt:
  R2（1:1 / tool continuation take-all）· R3（_ibImageDrain 无 actor）· R4（projectFiles.lastModifiedBy）
  —— 全部按冻结范围**未处理**，留给 P29-C。

Commit status:
  IMPLEMENTATION PASS / COMMIT DEFERRED BY OWNERSHIP（工作区仍含 P11–P29 多批未提交改动，未 stage、未 commit）
```

Notes（1 条，见 §8 与 §20）：P29-3 §10 case 3 的字面语义（"actor 无匹配 ⇒ not mine"）与 §19 的兼容契约
（唯一允许的行为差异只有两条）冲突；实现按 §19 + communication.js 既有文档化语义取"**无匹配 = 无主 ⇒ 首轮兜底**"，
并把该判断写入测试。这是本阶段唯一的实现取舍，未改变任何 canonical/契约面。

---

## 2. Root Cause

```
cfg.id（producer 当场已知）
   ↓  _execWsOps(ops, authorName, cfg, ictx)        ← 只把显示名交出去
actor = authorName（display）
   ↓  四条 runtime queue
_gInjMine(it) → it.actor === selfName                ← 同名角色互相匹配
```

canonical identity 在**写入 runtime item 时**被丢弃，reader 只能用显示名判归属 ⇒ 同名错配
（P29-1 §9 探针实证：B 产生的条目被 A 消费、B 自己看不到；无关 1:1 会话也会消费）。
本阶段把 identity 在 producer 端**保留**下来（preserve，不 reconstruct）。

---

## 3. Frozen Contract

| 项 | 冻结值（P29-2） |
|---|---|
| 字段 | runtime item 新增 **additive** 字段 `actorId`；`actor` 保持 display-only |
| 来源 | `cfg.id`（= `apiConfigs.id` = P24 `metadata.speakerId` 同一 domain） |
| 读取 | `actorId` 非空 ⇒ canonical 比较（mismatch ⇒ not mine，**绝不**回退 display）；空 ⇒ legacy 唯一精确显示名；歧义/非法 ⇒ not mine；`actor`+`actorId` 都空 ⇒ 既有首轮兜底 |
| 不变 | 1:1 take-all、image drain、projectFiles、session/conversation scope、P24、P23、DB schema |
| 禁止 | 新 Authority / Manager / Bus / Store / identity subsystem / 新 resolver |

实施中未偏离以上任一条。

---

## 4. Files Changed

| 文件 | 类型 | P29-3 hunk（本阶段新增/修改行） |
|---|---|---|
| `assets/js/workspace.js` | production | `:329` actorId 计算；`:393/500/521/523/525/527` op-feedback push；`:441` read entry；`:493` run ctx；`:592` run 卡片 ctx；`:599` tool 卡片 ctx；`:688` `_wsCheckPhantom` 签名；`:695/701` phantom push |
| `assets/js/workspace/run.js` | production | `:203-204` run-output push 带 actorId |
| `assets/js/site-operations.js` | production | `:291-293` `_ibQueueToolResult` 第 5 参；`:326/335/342/344` `_ibExecToolOp`→Inner 透传；`:357/362/371/376/393/394` 工具反馈与结果 push + pendingConfirm 回传；`:409/413/419` 卡片确认路径 |
| `assets/js/communication.js` | production | `:1857-1879` `_gInjParticipants()` + `_gInjMine` canonical-first；`:2729/3179/3291` 三处 `_wsCheckPhantom` 透传 `cfg.id`；`:2367-2368` 注释更新 |
| `tests/test_workspace_actor_identity.js` | 新增测试 | A1–A16（49 checks） |
| `tests/test-all.js` | 仅登记 | browser 组新增一条 |
| `docs/P29-3-WORKSPACE-ACTOR-IDENTITY-IMPLEMENTATION.md` | 新增文档 | 本报告 |

**worktree 说明**：4 个 production 文件的 `git diff` 同时包含更早批次（P11–P29）的未提交改动；
本阶段只编辑上述 hunk，未覆盖任何既有工作。

---

## 5. Producer Changes

```js
// workspace.js:329（_execWsOps 顶部，一次计算）
var actorId=(cfg&&typeof cfg==='object')?String(cfg.id||''):'';
```

* 四类 runtime item 全部携带 `actorId`（read / op-feedback / run-output / tool-result）；
* `actor` 原值**逐字不变**（仍来自 `authorName`）；
* 新增字段是 additive：既有键、既有顺序、既有文案、既有生命周期均未改；
* `actor = cfg.id` 这类替换**不存在**（测试 A2 锁定）。

---

## 6. Propagation Changes

| 路径 | 改动 |
|---|---|
| `_execWsOps` → run | `_rCtx.actorId`；run 卡片 ctx `_rc.actorId`（用户点「运行」后仍带 canonical id） |
| `_execWsOps` → tool | `_ibExecToolOp(op,author,ictx,actorId)` → `_ibExecToolOpInner(op,author,actorId)`；pendingConfirm 返回值带 `actorId`，tool 卡片 ctx `_tc.actorId` |
| `_wsCheckPhantom` | 新增第 4 参 `actorId`；群聊/1:1 流式/1:1 非流式三个调用点传 `cfg.id` |
| `_wsQueueRunOutput` | `{actor:ctx.author, actorId:String(ctx.actorId||''), text}` |
| `_ibQueueToolResult` | 第 5 参 `actorId`（旧调用点省略 ⇒ `''`） |

**未在中间任何一步把 actorId 归一成显示名 / friendId / groupId / provider key**（测试 A11 语义由 A1 的
run/tool 断言 + 源码守卫覆盖）。

---

## 7. Reader Changes

```js
// communication.js（_buildGroupChatContext 内）
var _gInjMine=function(it){
  var _aid=String((it&&it.actorId)||'');
  if(_aid)return _aid===String(cfg.id);                 // ① canonical wins（mismatch ⇒ not mine）
  var _a=String((it&&it.actor)||'');
  var _parts=_gInjParticipants();                        // 惰性：只有 legacy 路径才取
  var _hits=0,_only='';
  for(var _hi=0;_hi<_parts.length;_hi++){
    if(_a&&String(_parts[_hi].name||'')===_a){_hits++;_only=String(_parts[_hi].id||'')}
  }
  if(_hits===1)return _only===String(cfg.id);            // ② legacy 唯一精确名 ⇒ 归属该参与者
  if(_hits>1)return false;                               // ② 同名歧义 ⇒ fail closed
  return isFirstTurn;                                    // ③ 无主 ⇒ 既有首轮兜底
};
```

参与者名单**复用既有同源 helper**：`_ibGroupParticipants(getGroupMemberIds(group))`
（与 `sendChatMessage` 的 `_gParticipants` 同一份来源；无新注册表、无第二次 DB 读）。

**实施中的一处修正（测试抓到的真实缺陷）**：初版 `_gInjMine` 直接引用 `_gParticipants`，
但该变量在 `_buildGroupChatContext` 作用域内不可见 ⇒ legacy 路径抛 `_gParticipants is not defined`，
该成员本轮**不产出任何请求**。已改为按同源 helper 惰性构建（canonical 路径根本不读它），
并由 A7/A8/A10 三个真实回合用例锁定。

未新增 resolver/manager；`_gInjMine` 只做比较与归属。

---

## 8. Legacy Behavior

| 输入 | 行为 |
|---|---|
| `{actorId:'X'}` 且 X=当前 speaker | mine（消费并注入） |
| `{actorId:'X'}` 且 X≠当前 speaker（**即使 actor 显示名匹配**） | not mine（canonical wins） |
| `{actorId:'foreign'}` + actor 同名 | not mine（A9） |
| `{actor:'唯一名'}`（本群唯一） | mine 仅对该角色（A7） |
| `{actor:'同名'}`（≥2 命中） | not mine（A8，fail closed） |
| `{actor:'User'}` / 已退群成员名（本群无匹配） | **既有首轮兜底**（不是 not mine —— 见 §1 Notes 与 §11） |
| `{actor:'',actorId:''}` | 既有首轮兜底（A10） |

---

## 9. Same-name Isolation

真实群回合（A/B 同名"希儿"，C 名"第三角色"）+ 真实注入点：

```
c1  {actor:'希儿', actorId:'friend_p293_b'}  → A=false  B=true   C=false   queue 归零
c2  {actor:'第三角色'(C 的显示名), actorId:'friend_p293_b'} → A=false B=true C=false
```

c1 证明**同名隔离**；c2 证明 **canonical 压过 display**（显示名指向 C，但条目只进 B）。

---

## 10. Canonical Precedence

见 §9 c2 与测试 `A6.canonicalWinsOverDisplayName`；源码守卫
`A5.readerNoDisplayFallbackAfterCanonicalMismatch` 进一步锁定：`actorId` 分支在 `(it&&it.actor)` 读取**之前**
直接 return，canonical mismatch 后不存在任何 display 回退路径。

---

## 11. No-attribution Compatibility

`{actor:'',actorId:''}`（例如 guard 熔断条目，`site-operations.js:316` 有意保持无归属）仍由**本轮首个发言者**消费：
测试 `A10.noAttributionFirstSpeakerFallback`（A=true，B/C=false）。该条目**不被丢弃**（P29-3 §11 要求）。

同一条兜底也覆盖"本群无匹配的 actor"（用户手动跑脚本的 `'User'`、已退出成员）——
这是 §1 Notes 记录的取舍，也是 communication.js `:2367-2368` 既有的兼容语义。

---

## 12. 1:1 Compatibility

`communication.js:1724`（1:1 context）与 `:4417`（tool continuation）**未加任何 filter**，
仍为 take-all；源码守卫 `A12.singleChatInjectionStillTakeAll` / `A12.toolContinueInjectionStillTakeAll`
+ `A12.noConversationScopeField` 锁定。R2 保留给 P29-C。

---

## 13. Image Boundary

`_ibImageDrain` **零改动**：仍是裸 `dataUrl` 字符串数组（`workspace.js:390/462` push、
`site-operations.js:239` 声明、`communication.js:2536/2950/4425` 消费）。
守卫 `A13.imageDrainUnchanged`（源码）+ `A13.imageDrainStillRawStrings`（运行期）。R3 → P29-C。

---

## 14. projectFiles Boundary

`wsSaveFile`/`wsEditFileContent` 的 `lastModifiedBy=author||'AI'` 与 `workspace.js:32` 的导入避让判断
**一字未改**；`workspace/files.js` 内不出现 `actorId`（不做 UI 渲染）。
守卫 `A14.projectFilesWriterUnchanged` / `A14.importGuardUnchanged` / `A2.actorIdNotRenderedInFileUI`。R4 → P29-C。

---

## 15. P24 Boundary

`group-runtime-core.js` **零改动**（文件内无 `actorId`）；`planVersion=3`、`plannerId=group-rule-v1`、
`memberTurnIdFor` 公式（与 `chat-core.stableToken` 逐字等值）、targeting / recent / cap / SILENT / DEFER 全部未触碰。
守卫 `A16.*`（4 条）。

---

## 16. P23 Boundary

P23 五核心（delivery-planner / multimodal-delivery-policy / delivery-sequence-core / delivery-runtime /
voice-message-core）内无 `actorId`，未修改。守卫 `A16.p23Untouched`。

---

## 17. DB / Persistence Boundary

`DB_VER=24`（源码 + 运行期双重断言）；4 个改动文件内无 `createObjectStore`；
无 migration、无新 IndexedDB 字段要求、无 localStorage 身份持久化、无 Home Node schema 变化。
`actorId` 是 **runtime-only enrichment**。守卫 `A15.dbVer24` / `A15.noSchemaTouch` / `A15.runtimeDbVer24`。

---

## 18. Tests

**新增 `tests/test_workspace_actor_identity.js` → 49 checks 全绿**（Node 源码守卫 + 真实浏览器）：

| 组 | 断言 | 结果 |
|---|---|---|
| A1 | 四类 item 均带 `actorId===cfg.id`（read / op-feedback / run-output / tool-result）+ phantom 透传 | PASS |
| A2 | 四类的 `actor` 仍等于原显示名；`actor` 未被 cfg.id 替换；文件 UI 不渲染 actorId | PASS |
| A3 | 四类覆盖（同上，逐类型断言，非抽样） | PASS |
| A4 | cfg 边界：`null` / `undefined` / primitive（`'p4a-json'`）/ 无 id 对象 ⇒ `actorId===''` 且不 crash；不按显示名反查 | PASS |
| A5 | 同名隔离（c1：只有 B 收到）+ 条目只被消费一次 | PASS |
| A6 | canonical precedence（c2：显示名指向 C，条目只进 B） | PASS |
| A7 | legacy 唯一名 ⇒ 只进该角色 | PASS |
| A8 | legacy 同名歧义 ⇒ 无人收到且条目**不被丢弃** | PASS |
| A9 | foreign actorId ⇒ 无人收到 | PASS |
| A10 | 无归属 ⇒ 本轮首个发言者兜底 | PASS |
| A11 | 传播：run ctx 与 item、phantom、tool 结果逐字保留 canonical id | PASS |
| A12 | 1:1 / tool continuation 仍 take-all；无 conversation scope 字段 | PASS |
| A13 | image drain 形状与消费点未变 | PASS |
| A14 | projectFiles 写入与导入避让判断未变 | PASS |
| A15 | DB_VER=24；无 schema 触碰 | PASS |
| A16 | P24（planner/memberTurnId/core）+ P23 五核心零变化 | PASS |
| 附带 | P29-0 退化诊断 `_ibGroupIdentityDegradedSnapshot()` 仍为 `{}`（两系统独立） | PASS |

**回归（Level 1 focused，§25B）**：`test_workspace_smoke.js` ✔ ·
`test_identity_read_path_closure.js` 54 ✔ · `test_group_speaker_identity.js` 50 ✔ ·
`test_group_turn_identity.js` 99 ✔ · `test_p11_3d_tool_execution_guard.js` ALL PASS ✔ ·
`test_image_router_smoke.js` ✔ · `test_moments_phase4_smoke.js` ✔。

**未跑 full quick**（§26 明令；本阶段未改 shared schema / DB version / P24 contract）。

---

## 19. Differential Verification

真实浏览器、真实注入点，同一 fixture：

```
Before（P29-1 探针，display-only item {actor:'希儿'}）
  A sees result = true      B sees result = true（同名互判 / 先构建上下文者独占）

After（canonical item {actor:'希儿', actorId:'friend_p293_b'}）
  A _gInjMine = false       B _gInjMine = true        ← A5

Legacy ambiguous {actor:'希儿'}（无 actorId）
  A = false                 B = false                  ← A8（fail closed，条目保留）

Legacy unique {actor:'第三角色'}
  A = false B = false       C = true                   ← A7
```

---

## 20. Remaining P29-C Items

| # | 项 | 状态 |
|---|---|---|
| R2 | 1:1 context（`communication.js:1724`）与 tool continuation（`:4417`）take-all ⇒ 仍可能消费其它会话/角色的条目 | **未处理**（需 session scope 决策） |
| R3 | `_ibImageDrain` 无 actor identity（裸 dataUrl） | **未处理**（需形状变更决策） |
| R4 | `projectFiles.lastModifiedBy`（persisted display 名，参与导入避让的语义判断） | **未处理**（需持久化语义决策） |

另记一条**本阶段新增的观察**（不属于上述三项）：`site-operations.js:316` 的 guard 熔断条目
刻意保持 `actor:''`（无归属）⇒ 走首轮兜底；若未来希望它也只进"触发熔断的那个成员"，
需要在该路径拿到 actorId（属 P29-C 决策）。

---

## 21. Worktree / Commit Status

| 项 | 结果 |
|---|---|
| 修改前 hash（记录，§29 要求） | communication.js `A753B16913DFE375` · workspace.js `9093AC1D2D6FD46C` · run.js `461FE6B217432AF3` · site-operations.js `4F2189013EAA8758` |
| 修改后 hash | communication.js `423F0156E6A5C1A6` · workspace.js `059E1E0D4B7E0750` · run.js `F907196BF2441668` · site-operations.js `630386F5E3D0C5A6` |
| 范围审计 | 今日 17:00 之后被修改的 production JS **恰好 4 个**（= 允许清单）；`actorId` 未引入到任何其它 production 文件 |
| 其它 production 文件 | 未触碰（示例：`autonomy-core.js` 9/19 21:01、`agent-orchestration-core.js` 9/20 06:46） |
| git 操作 | 未使用 `checkout --` / `restore` / `reset --hard` / `clean` / stash；未 stage、未 commit |
| 临时产物 | 诊断脚本写在仓库根的 `tmp_p293_dbg.js`，运行后已删除（`git status` 无残留） |
| 隔离判断 | 4 个 production 文件同时含更早批次未提交改动 ⇒ P29-3 hunks **不能**与其它批次安全隔离 ⇒ **COMMIT DEFERRED BY OWNERSHIP** |

---

## 附 · 与冻结清单的逐条对齐（P29-3 §0）

| 冻结项 | 实施结果 |
|---|---|
| 1/2 `actorId` 新增 + actor display-only | ✔（§5，A2 锁定） |
| 3 来源 = `cfg.id` | ✔（§5，A1 锁定） |
| 4 preserve，不 reconstruct | ✔（无显示名反查，A4 守卫） |
| 5 只改 group attribution filter | ✔（`_gInjMine` 唯一 reader 改动 + 3 处透传） |
| 6 canonical precedence / legacy / fail closed | ✔（§7–§10，A5–A9） |
| 7 1:1 take-all 保持 | ✔（A12） |
| 8 不引入 conversation/session scope | ✔（A12） |
| 9 不处理 `_ibImageDrain` | ✔（A13） |
| 10 不处理 `projectFiles.lastModifiedBy` | ✔（A14） |
| 11 不改 P24 / memberTurnId / planner / targeting / recent / P23 / DB | ✔（A15/A16 + P23 五核守卫） |
| 12 不新增 Authority/Manager/Bus/Store/identity subsystem | ✔（A5.noNewResolverIntroduced + 无新文件） |

## 停止条件检查

需要修改 P24 identity contract / memberTurnId / planner / DB schema / session scope /
image drain shape / projectFiles persisted contract / 新 Authority / 新 identity subsystem？
**全部为否** ⇒ 未触发任何停止条件。
