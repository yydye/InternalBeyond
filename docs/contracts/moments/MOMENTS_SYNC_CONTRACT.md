# Moments Sync Contract

**Status: Canonical**
**Scope: Browser ↔ Home Node Moments synchronization 与 hydration**

> 当前状态 contract。来源：`assets/js/moments-authority.js`、`assets/js/home-node-client.js`
>（`createMomentsRemote`）、`assets/js/home-node-bootstrap.js`、`tests/test_moments_authority.js` /
> `test_p11_3f_moments_hydration_safety.js`。

---

## 1. 方向摘要

| 方向 | 触发 | 数据 | 策略 |
| --- | --- | --- | --- |
| Browser → Home Node | create / update / delete | record payload | Home Node authoritative；CAS + idempotency |
| Home Node → Browser | hydrate / changes | records、tombstones | mirror 由 canonical replace/patch |
| Companion → Home Node | none | — | Companion 不持久化（见 `MOMENTS_COMPANION_CONTRACT.md`） |

`moments_revision` 是 isolated namespace（一次 Moment 写入不会使 chat/memory cursors 失效）。

---

## 2. Browser → Node

- Endpoints：`POST /moments/record`（单条）、`POST /moments/records`（批量）、`DELETE /moments/record`。
- `requestId` 提供 **idempotency**（replay → `replayed`，无重复写入）。
- `expectedRev` 在 update 时提供 **CAS**；不匹配会被拒绝（不会静默覆盖并发
  编辑）。
- 写入**先**发往 Home Node；成功后更新 browser mirror。

---

## 3. Node → Browser

```
ensureReady()
  ├ not hydrated → hydrate()  (GET /moments/list)
  │     → replaceAll(records)            ← authoritative replace
  └ hydrated     → GET /moments/changes?cursor=
        → apply upserts / tombstones ; cursor advances
```

额外的 read/ack endpoints：`GET /moments/visible`（visibility-scoped）、`POST /moments/ack`、
`GET /moments/migration`。

---

## 4. Hydration Contract (P11-3F)

```
ONE CANONICAL REMOTE STATE — ONE LOCAL MIRROR
```

- Hydration 执行 **authoritative replace**（`replaceAll`），而非 merge。
- authority **拒绝**：
  - 不完整的 snapshots → `incomplete-snapshot`；
  - 无效的 responses → `invalid-response`。
- `hydrateGen` watermark 确保过期的 hydrate 无法覆盖更新的 hydrate。
- 被拒绝的 hydrate 会保持先前的 mirror 状态不变。

> Moments 的 hydration 行为不同于 `MEMORY.md` 中记录的 Memory 历史隐患：
> Moments 拒绝错误的 page，而不是用它清空 mirror。

---

## 5. Failure 语义

Local/mirror 失败会以分类错误呈现（`mirror-quota`, `mirror-unavailable`,
`mirror-not-written`, `event-rejected`），而不是上报为 success。Remote 失败会使
authority 降级（`degradedReason`），而不是静默切换 authority。

---

## 6. Non-goals

本 contract 不定义 ACL、record 字段或 Companion 行为。

---

## 7. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_p11_3f_moments_hydration_safety.js` | hydrate refusal + gen protection |
| `tests/test_moments_authority.js` | sync / changes / cursor |
| `tests/test_moments_http.js` | Node endpoints |

---

## 8. 历史起源

`assets/js/moments-authority.js` (canonical hydration contract P11-3F).
