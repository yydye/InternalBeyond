# Companion Active Runtime Contract

**Status: Canonical**
**Scope: Browser ↔ Active service protocol（schedule sync、execution、queue、import/ack）**

> browser 与后台 Active service 之间的当前状态 Contract
> （`services/active-message-service.js`）。来源：`services/active-message-service.js`、
> `active/http.js`、`active/scheduler.js`、`active/plan-domain.js`，以及 `tests/test_active_http.js` /
> `tests/test_active_plans.js`。Autonomy 机制（frequency/retry/dedup）见 `AUTONOMY.md`；本
> Contract 固定 **protocol 与 ownership**。

---

## 1. Schedule 所有权

- **browser 拥有 plans 与 settings**（`active_message_plans`、`active_message_settings`）。
- 只有 `background_enabled` 开关为 on 的 schedules 才会同步到 service。
- service 执行同步过来的 plans；它不会自行发明 schedules。

---

## 2. Execution

```
schedule → plan-domain → character model → validation → dedup / DND → queue
```

- `active/plan-domain.js` 负责 sanitize、run/message ids、`isInDnd` / `nextDndFree`，以及
  send/reschedule/cancel 的决策形态。
- `active/scheduler.js` 负责 tick、evaluation，以及 queue state 的持久化。
- character model 通过 `active/model-client.js` 调用。

---

## 3. Queue

- service 可以**持久排队（durably queue）**生成结果（在 OS notification 之前持久化）。
- queue 条目携带 `acknowledged` 标志，且不是 canonical chat rows。

> queue ≠ canonical chat storage

---

## 4. Import / Acknowledge

```
service result → browser import → browser persistence/delivery → acknowledge
```

| Endpoint | Method | 用途 |
| --- | --- | --- |
| `/health` | GET | service 健康检查 |
| `/proactive/traces`, `/proactive/debug` | GET | 可观测性（不做决策） |
| `/tasks` | GET | task 列表 |
| `/plans` | GET | plan 列表 |
| `/moments` | GET | moments 状态 |
| `/events` | GET | 某 user 的**未确认** events（`user_id`、`limit`） |
| `/events/:id/ack` | POST | 确认单个 event（将 history 标记为 acked，并从 queue 移除） |
| `/history` | GET / DELETE | history 列表 / 清空 |
| `/reconcile` | POST | browser 声明其拥有的 `task_ids` / `plan_ids` / `moment_ids`；service 按 user 清理未被声明的项并 **arms** 该 user |
| `/bg-ai` | GET / POST | background-AI 开关 |
| `/credentials` | POST | credential 配置（不属于 Companion） |
| `/economy/propose-purchase` | POST | **Economy** surface，不属于 Companion |

runtime 中观察到的 ownership 规则：

- `/events` 只返回请求 user 自己的未确认 events。
- `/events/:id/ack` 拒绝属于其他 user 的 event（403）。
- `/reconcile` 仅当某个集合出现在请求中（已声明所有权）时才清理该集合；
  **arming 是最后一步且为 process-local** —— 失败的 reconcile 绝不会启用 scheduling。

---

## 5. 崩溃 / 恢复

scheduler 执行 **crash-leftover recovery** 与 history trimming（`active/scheduler.js` 头部）。
queue state 会被持久化，因此重启后会恢复 queue 而不是丢弃它。此处不主张任何额外的恢复保证。

---

## 6. 边界

- service 是 **executor + queue**，既不是 chat storage authority，也不是 message-lifecycle authority。
- browser 仍然是 plans、chat storage 与 delivery 的 authority。
- Companion 没有 provider authority；它调用 character model（`active/model-client.js`）。

---

## 7. Non-goals

本 Contract 不定义 proactive frequency policy、DND windows、dedup thresholds 或 delivery
timing（见 `AUTONOMY.md` 与 proactive interaction contract）。

---

## 8. Enforcement

| Test | 固定内容 |
| --- | --- |
| `tests/test_active_http.js` | service HTTP surface（events/reconcile/ack 行为） |
| `tests/test_active_plans.js` | plan sync / execution ownership |
| `tests/test_runtime_convergence_proactive.js` | browser↔service convergence（无重复发送） |

---

## 9. 历史来源

`services/active-message-service.js`、`active/*`；机制背景见 `docs/AUTONOMY.md`。
