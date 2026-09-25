# P26-3 · Session Runtime Contract

状态：**FOUNDATION / CONTRACT / PURE CORE / AUDIT-FIRST / NO PRODUCTION INTEGRATION**。
建立 `assets/js/session-core.js`。
**Production sessions = 0**：Cinema / Voice / Co-read / Activity / Group Runtime / P23 /
Active Message 全部零接线、零改动。

---

## 1. Definition

> **Session = a bounded runtime lifecycle containing participants, state transitions,
> and temporal continuity.**

「有界」= 有明确的开始与结束边界；「participants」= 生命周期内的成员资格；
「state transitions」= 有限、确定性的状态迁移；「temporal continuity」= 跨多次动作存续，
而不是一次动作。

## 2. Non-definition（Session **不是**）

| 不是 | 为什么 |
| --- | --- |
| Event | 事件是"发生了什么"的**过去事实**（P26-1）；Session 是跨动作存续的**运行单元** |
| Observation | 观察是"现在是什么"的**读取描述**（P26-2）；Session 不描述状态，它**承载**运行时状态 |
| Capability | 能力是"请求一个域动作"（P25）；Session 不执行任何动作 |
| Canonical Record | canonical 行是域业务数据；Session 只持**运行时**状态（identity / participants / status / 时间） |
| Resource | 资源是被占用的对象（影片 / 播放器 / 频道）；Session 只是围绕它的运行生命周期 |
| Turn / Task / Transport | 回合（P24 group turn）、任务（Active 计划）、传输（HTTP 轮询）各自有明确归属，不叫 Session |

## 3. Lifecycle（证据驱动的最小集合）

**状态闭集 = `created` / `active` / `ended` / `failed`**（`paused` **NOT PRESENT**）。

| 状态 | 为什么需要（证据） |
| --- | --- |
| `created` | 仓库里"创建"与"开始"是两个动作：`createActivity({…})` 与随后 `setCurrent(id)`；`IBMedia` 加载是异步的 ⇒ 存在"已创建、尚未开始"的真实窗口 |
| `active` | Cinema 观看中、Co-read 阅读中、Voice 通话中、群回合进行中都是"进行中" |
| `ended` | `activities.status==='finished'` 在 **5 处读侧**被判定（`_usableFor` / `setCurrent` / `resolveActivity` / `send` / `nudge`）；P23 交付队列有 `completed`；语音通话有结束 |
| `failed` | P23 交付队列有 `failed`；Active 计划有 `failed` ⇒ "中途失败"必须与"正常结束"区分 |

**`paused` 为什么不加入**：P25-3E 已证明**活动级 pause 不存在**（`cinema.pause` 只是
`IBMedia` 的**媒体传输控制**）；把传输暂停提升为会话生命周期会伪造一个产品并不存在的状态。
若未来真的出现"暂停会话"的产品语义，应作为**显式扩展**单独论证（并同时定义 resume）。

## 4. Identity

`sessionId` 在生命周期内**稳定**。

**谁生成？** —— **调用方注入优先**（domain 或 runtime 都可以是 caller），未注入时由 core
**确定性派生**：`'sess_' + stableToken(domain|participants(sorted)|createdAt)`。

**不引入**：全局 session 计数器 / Session Registry / 隐藏的 `Date.now()` / `Math.random()`。
同一输入 ⇒ 同一 id（测试 S3），且 `participants` 的顺序不影响身份（集合语义）。

## 5. Participants

- **canonical identity**：参与者只能是 canonical id（`apiConfigs.id` / user principal id）；
- **禁止 nickname**：id 模式为 ASCII 字母数字 + `_.:-@|` ⇒ 任何含空格 / 非 ASCII 的昵称一律 `bad-participant-id`；
- 参与者是"**谁在这个会话里**"（角色 / 用户），**不是**资源，**不是** observer；
- `participants` 是**集合**：写入时按字典序规范化；**重复成员是显式错误**（`duplicate-participant-id`），不静默去重；
- 上限 32（防止把 Session 当成人群容器）。

## 6. State Ownership

| 允许（runtime state） | 禁止（canonical business state） |
| --- | --- |
| `sessionId` / `domain` / `participants` / `status` / `createdAt` / `updatedAt` / `endedAt` | `messages` / `content` / `body` / `payload` / `history` / `chat` / `transcript` / `memories` / `images` / `audio` / `base64` / `files` … |

即 **`{ active:true, participants:[] }` 允许**、**`{ messages:[] }` 拒绝**（`forbidden-state-field`）。
未知字段同样拒绝 —— 不给"业务正文槽"留逃生舱。

## 7. Event Relation

**Session Event ≠ Session。** 会话可以（在未来）产生事件（例如 `session.started` / `session.ended`），
但本阶段**不接 Event Bus**：core 里没有 `emit()`、没有事件存储、没有订阅。
未来接线时，事件仍是 P26-1 的 **post-effect fact**（会话状态已经迁移 → 才发事件），
而且**不得**成为第二个 canonical writer。

## 8. Observation Relation

**Observation 可以描述 Session**（例如 `domain:'voice'` + `entityId:sessionId` +
`source:'voice.runtime'` + `valueRef:'session.active'`），但：

- Observation **不拥有** Session；
- **禁止**把 session 对象塞进观察（P26-2 已冻结 `forbidden-value-field`，内联状态会被拒）；
- 「session.active 观察」≠「session 对象」。

## 9. Capability Relation

Session **不能**执行 capability、**不能**绕过 Authority、**不能**直接调用 Executor
（守卫 S13/S14：core 内零 `Authority` / `decide` / `createMoment` / `writeDiary` / `sendMessage` /
`writeLetter` / `createActivity` / `executor` 命中）。
会话只是运行时容器；动作仍然走 P25 的 `Candidate → Authority → Executor → Writer → Verify`。

## 10. Resource Relation

Session **不** lock / lease / 仲裁优先级或抢占（守卫 S15）。"谁能占用资源"是
**P26-4 Resource Arbitration** 的问题。

## 11. Persistence

本阶段**不实现 session persistence**：零 IndexedDB / localStorage / SQLite / 文件 / session store
（守卫 S9；`DB_VER` 与 store 列表未变）。是否持久化是未来域策略。

## 12. Transport

**禁止** WebSocket session manager / RTC session / IPC session（守卫 S10）。
Core 是 runtime-neutral 纯模块：Node 与浏览器都能 require，且不触碰任何运行时 API。

## 13. Failure（§18）

`transitionSession(session, nextStatus, context)` **返回 result，不抛异常**，
也**不**自动恢复、**不**自动重试：

| 情况 | 结果 |
| --- | --- |
| 非法迁移（`paused` 之类不在表内的目标、或 `active → created`） | `{ok:false, errors:['invalid-transition'], reason:'invalid-transition'}` |
| 终态再迁移（`ended` / `failed` → 任意） | `{ok:false, errors:['already-terminal'], reason:'already-terminal'}` |
| 缺 `context.at`（迁移时间）/ 时间早于 createdAt / 终态时间倒退 | `{ok:false, errors:['missing-transition-time'], reason:'missing-transition-time'}` |
| session 本身非法 | `{ok:false, errors:[…], reason:'invalid-session'}` |
| 合法迁移 | `{ok:true, session:<新的冻结对象>, errors:[], reason:''}`（**原对象不变**） |

**不读时钟**：迁移时间必须由调用方注入（`context.at`）。

## 14. Transition Table（deterministic）

| from \ to | `created` | `active` | `ended` | `failed` |
| --- | --- | --- | --- | --- |
| `created` | — | start ✅ | 未启动即放弃 ✅ | 未启动即失败 ✅ |
| `active` | ❌ | — | end ✅ | fail ✅ |
| `ended` | ❌ | ❌ | ❌（终态） | ❌（终态） |
| `failed` | ❌ | ❌ | ❌（终态） | ❌（终态） |

`canTransitionSession(session, nextStatus)` 是同一张表的纯查询；`transitionSession` 是它的执行面。

## 15. Examples（EXAMPLE ONLY —— 生产 sessions = 0）

```
// Cinema 观看会话（示例；今天 Activity 只有"记录 + 指针"）
{ sessionId:'sess_…', domain:'cinema', participants:['role_a'], status:'active',
  createdAt:1770000000000, updatedAt:1770000060000 }

// Voice 通话会话（长期存续；今天 voice runtime 只有内部状态）
{ sessionId:'sess_…', domain:'voice', participants:['role_a','user_1'], status:'active',
  createdAt:1770000000000, updatedAt:1770000010000 }

// 群聊交互会话（示例；P24 的 group turn 是回合，不是会话）
{ sessionId:'sess_…', domain:'group', participants:['role_a','role_b','role_c'], status:'active',
  createdAt:1770000000000 }

// 已结束（终态，不可再迁移）
{ sessionId:'sess_…', domain:'cinema', participants:['role_a'], status:'ended',
  createdAt:1770000000000, updatedAt:1770000600000, endedAt:1770000600000 }
```

创建与迁移（纯函数）：

```js
const s = IBSessionCore.createSession(
  { domain:'cinema', participants:['role_a'], createdAt: 1770000000000 }
);                                    // → status:'created'
const a = IBSessionCore.transitionSession(s.session, 'active', { at: 1770000000001 });
const e = IBSessionCore.transitionSession(a.session, 'ended',  { at: 1770000600000 });
```

## 16. Non-goals

本阶段**不**实现：Session Manager · Session Registry · Session Store / cache · Session Router ·
Session Bus · Realtime Session Sync · Presence System · Voice Session Runtime ·
Cinema Session Runtime · Resource Arbitration · Feedback Loop · Agent Wake；
**不**接入任何真实 session 生产入口；**不**修改 Cinema / Voice / Co-read / Activity /
Group Runtime / P23 / Active Message / P25 foundation；**不**新增 store / DB migration。

---

## 附：Existing Session-like Audit（Phase 0，只读）

| 候选 | 事实（代码） | 分类 | 进 Session Contract？ |
| --- | --- | --- | --- |
| A. Cinema playback lifecycle | `open()` → `createActivity`/`findActivity` → `setCurrent`；`IBMedia` adapter load/play/pause/seek；卸载 `clearCurrent` | **B. Activity Session** | YES（未来 integration；今天仍是 Activity 记录 + App 内存） |
| B. Co-read lifecycle | 打开书 → 活动记录 + `setCurrent`；翻页 → `setProgress`；返回书架 → `clearCurrent` | **B. Activity Session** | YES（同上） |
| C. Voice call / playback | `communication/voice.js` 的通话 / 播放内部状态；语音呼入是 Active Message 的 `voice_call` **计划** | **A. Long-lived Session**（通话）+ 计划（不是 session） | YES（通话是最典型的未来 candidate） |
| D. Activity runtime | `activities` 记录 + 每角色 current 指针 + App 内存；`status` 只有 `active`（`finished` 无写入者） | **B**（记录 + 指针，**不是**完整 session） | YES（Session Contract 正是为它补生命周期语义） |
| E. Group conversation turn | `groupTurnId` / `MemberTurn.turnId` / `groupOrder` / participation planner | **C. Interaction Session**（回合粒度） | 部分：**回合不是会话**；未来"群活动"需要会话层时再依赖 P24 身份 |
| F. Active Message execution | 任务快照 + 计划状态机（scheduled / evaluating / sending / waiting / failed…）+ run id | **D. Execution Session**（执行生命周期） | 部分：它是**任务**而非多方会话；本阶段不接入 |
| G. P23 delivery lifecycle | 内存队列 `queued → delivering → completed / cancelled / failed`（+ typing + cancel） | **D. Execution Session**（交付生命周期） | 部分：交付队列已有自己的状态机，P23 冻结；不得被 Session Contract 取代 |

**不强行统一**：只有 A/B/C（以及 D 的未来形态）适合用 Session Contract 描述；
E 是回合、F/G 是执行 / 交付生命周期，各自已有归属。
