# Memory Authority Contract

**Status: Canonical**
**Scope: Memory storage authority、mirror policy 与 write invariants**

> 当前状态 contract。它固定谁拥有 durable memory state、browser mirror 与其如何关联，以及保持二者一致的
> write ordering。它不描述 retrieval scoring
>（见 [`../../architecture/MEMORY.md`](../../architecture/MEMORY.md)）或 record shape
>（见 [`MEMORY_RECORD_CONTRACT.md`](MEMORY_RECORD_CONTRACT.md)）。

---

## 1. Authority

```
Home Node  = canonical      (services/home-node/memory-store.js)
Browser    = mirror         (IndexedDB store `memories`)
Mobile     = denied         (no memory verb, no cache)
```

- Canonical durable state 是 Home Node `memory_records`（外加 `memory_change_log` 与 `memory.*` meta）。
- browser IndexedDB `memories` store 是一个 **mirror / migration source / rollback shadow**。
- Mobile 没有 memory authority、没有 memory sync，也没有 memory cache。

Evidence：`assets/js/memory-authority.js`；`assets/js/home-node-bootstrap.js`（memory authority assembly）；
`docs/HOME_NODE_CHAT.md §15`；`services/home-node/http.js` `memoryPolicy`；`services/home-node/mobile-gateway.js`。

---

## 2. 写入不变量（canonical mode）

```
write request
   │
   ▼
Home Node write (POST /memory/records)
   │
   ├─ success ─► apply to browser mirror
   │
   └─ failure ─► NO mirror-only write; fail closed
```

- canonical write 会**先**发往 Home Node。
- 只有在 canonical write 成功之后，mirror 才会被更新。
- 在 canonical mode 下 Home Node 失败时，写入会 **fail closed**；它**绝不会**被仅记录到
  mirror 而当作 canonical 处理。

Evidence：`assets/js/memory-authority.js`（put path；`authority:'home-node'` vs `mirrorOnly:true`）；
`home-node-bootstrap.js` 的 memory authority notes。

---

## 3. 模式

| 模式 | 含义 |
| --- | --- |
| `canonical` | **默认。** Home Node 是 authority；写入 remote-first 且 fail closed。 |
| `mirror` | Legacy rollback 模式；browser 读取/写入 mirror。 |
| `off` | Authority 已禁用；读取/probing 时行为等同 mirror。 |

`MODES = ['canonical','mirror','off']`，默认 `canonical`（`assets/js/memory-authority.js`）。
`file://` origin 无法访问 Home Node，处于 degraded 状态（它不能是 canonical）。

---

## 4. 读取装饰

读取在本地提供，但会带上其 provenance 装饰：`authority:'home-node'` 以及 `readFrom`
值 `mirror`、`mirror-cold` 或 `mirror-degraded`。读取 mirror 与读取
canonical state 并不相同，装饰明确了这一点。

---

## 5. Non-goals

本 contract 不固定 retrieval scoring、consolidation decisions、UI rendering 或 record
字段列表。它在任何 mode 下都不会让 browser mirror 成为 durable authority。

---

## 6. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_memory_authority.js` | modes、write order、fail-closed、watermark、degraded reasons |
| `tests/test_mobile_memory_read_boundary.js` | device 无法访问 memory |
| `tests/test_mobile_memory_continuity.js` | browser/Node retrieval 一致性 |

---

## 7. 历史起源

`docs/HOME_NODE_CHAT.md §15`（M1-C.2d Wave 2）。历史演进：
`docs/history/runtime/CONTEXT-CONVERGENCE-C1-REPORT.md`。
