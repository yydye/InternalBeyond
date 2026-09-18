# Memory Sync Contract

**Status: Canonical**
**Scope: Browser ↔ Home Node memory synchronization、envelope 与 hydration**

> 关于 browser mirror 如何与 canonical Home Node store 保持一致，以及为什么 mobile 从不参与
> 的当前状态 contract。它不定义 storage authority
>（见 [`MEMORY_AUTHORITY_CONTRACT.md`](MEMORY_AUTHORITY_CONTRACT.md)）。

---

## 1. 方向摘要

| 方向 | 触发 | 数据 | 冲突策略 |
| --- | --- | --- | --- |
| Browser → Home Node | writes (create/update/delete) | record payload | Home Node authoritative；canonical mode 下 **fail closed**；绝不 mirror-only |
| Home Node → Browser | first load / `changes(cursor)` | upserts + deletes | mirror 由 canonical **replace/patch**；不 merge |
| Mobile ↔ Home Node | — | — | none；memory 对设备拒绝 |

canonical revision namespace 是 memory store 自身的（`memory_revision`）；一次 memory 写入不得
使 chat mirror cursor 失效，反之亦然（`HOME_NODE_CHAT.md §15.3`）。

---

## 2. Browser → Home Node（write path）

- 写入经过 `memory-authority` 并先落到 Home Node（`POST /memory/records`）。
- 成功 → 变更被应用到 browser mirror。
- 失败 → 不进行 mirror-only canonical write；操作 fail closed（canonical mode）。
- 写入通过以 `mem:` 为命名空间的 request key 实现 idempotent，因此 memory migration request id 不会
  与 chat message request id 冲突。

---

## 3. Home Node → Browser（mirror path）

```
ensureReady()
  ├ not yet hydrated → hydrate()
  │     remote.list(seedLimit) → local.replaceAll(page.records)
  │     cursor = page.revision ; hasFullHistory = !page.truncated
  └ already hydrated → remote.changes(cursor)
        → applyDeletes(...) ; applyUpserts(...) ; cursor = res.cursor
```

- `hydrate()` **replace** mirror（不 merge），因此已删除的 canonical records 不会滞留。
- `changes()` 先应用 deletes 再应用 upserts，并推进 cursor。
- 读取带有 `authority:'home-node'` 与 `readFrom`（`mirror` / `mirror-cold` /
  `mirror-degraded`）装饰。

---

## 4. Envelope

`/memory/*` 使用共享的 Home Node envelope。client 将 `payload` 字段合并到顶层，
同时保留 envelope metadata（`ok`、`status`、`type`、`serverTime`、`protocolVersion`、
`requestId`）——见 `assets/js/home-node-client.js` `_unwrapMemoryEnvelope`。

Memory endpoints 为 **desktop-only**（`/memory/list`, `/memory/changes`, `/memory/records`,
`/memory/record`, `/memory/activate`, `/memory/settings`, `/memory/migration`, `/memory/migrate`）。
它们不通过 `/mobile/v1` 暴露。

---

## 5. Mobile

```
No memory endpoint.
No memory sync.
No memory cache.
```

`services/home-node/mobile-gateway.js` 将所有 `/memory/*` 路径列为 desktop admin paths，且
`services/home-node/http.js` 声明 `memoryPolicy: { stored: true, servedToDevices: false,
deviceVerbs: [], injection: 'home-node-execution-only' }`.

---

## 6. Hydration 隐患

```
Known runtime hazard:
  hydrate() executes local.replaceAll(page.records). If the Home Node list
  response is empty, or its payload fails to unwrap (so `res.records` is
  undefined), the mirror is authoritatively cleared and retrieval can render an
  empty context despite canonical records existing.

Status:
  Documented, not fixed in this phase.
```

记录自 `assets/js/memory-authority.js`（hydrate）与 `assets/js/home-node-client.js`
（`_unwrapMemoryEnvelope` comment）。本文档**不**修复它。

---

## 7. Non-goals

本 contract 不定义 conflict-merge semantics（canonical mode 下不存在），不
使 mirror 成为 authoritative，也不授予 mobile 任何 memory surface。

---

## 8. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_memory_authority.js` | hydrate / changes / fail-closed / degraded reasons |
| `tests/test_mobile_memory_continuity.js` | browser/Node parity；device 无法访问 memory |
| `tests/test_mobile_memory_read_boundary.js` | device read boundary |

---

## 9. 历史起源

`docs/HOME_NODE_CHAT.md §15`（M1-C.2d Wave 2）；`docs/history/runtime/P2-CONTEXT-CONVERGENCE-AUDIT.md`。
