# Moments 架构

**Status: Canonical**
**Scope: 当前 Moments 架构**

> InternalBeyond Moments 子系统的当前状态描述。Source-of-truth 优先级：
> production code → running tests → contracts → canonical docs → history。`MOMENTS.md` 是 Moments 的
> **authority architecture**；social mechanism 位于 [`SOCIAL_RUNTIME.md`](../SOCIAL_RUNTIME.md)。

---

## 1. 定义

> **Moments 是一个独立的社交内容子系统**，拥有自己的 canonical persistence、ACL 和
> mirror。

它**不是**：Social authority、Companion 功能、Memory 子系统，或角色关系系统。

---

## 2. Social 边界

```
Social (umbrella — mechanism only)
    └── Moments (independent authority domain)
```

- `docs/SOCIAL_RUNTIME.md` = social **mechanism** authority（Social Loop、perception、emotion、
  relationship inputs）。它**不会**被本文档取代，也不会创建 `SOCIAL.md`。
- `docs/architecture/MOMENTS.md` = Moments **authority architecture**。

---

## 3. Runtime 位置

```
Generation
   ├── browser  assets/js/moments.js        (text gen, model call, image decision)
   └── Companion active/moments.js          (background trigger, generation request, event emission)
        │
        ▼
Moments authority  assets/js/moments-authority.js   (canonical / mirror / off; write-first-to-node)
        │
        ▼
Home Node  services/home-node/moments-store.js       (canonical persistence, revision, migration, retrieval, idempotency)
        │
        ▼
Browser mirror  (IndexedDB store `moments`, bootstrap-intercepted) → UI (moments.js / social-network.js)
```

Ownership 摘要：

- **Browser generation** — 文本生成、模型调用、图像决策。
- **Companion generation** — 后台触发、生成请求、事件发射（无持久化）。
- **Home Node** — canonical 持久化、revision、migration、retrieval、idempotency。

详情：[`../contracts/moments/MOMENTS_AUTHORITY_CONTRACT.md`](../contracts/moments/MOMENTS_AUTHORITY_CONTRACT.md)。

---

## 4. Storage Authority

Home Node `services/home-node/moments-store.js` 是 **canonical authority**。Browser IndexedDB
`moments` 是 **mirror / migration source / rollback shadow**（与 Memory/chat 形状相同）。

| 关注点 | 拥有者 |
| --- | --- |
| create | Home Node |
| update | Home Node |
| delete | Home Node (soft delete) |
| revision | Home Node (`moments_revision`) |
| cursor | Home Node (`change_log`) |
| migration | Home Node (watermark `migration:moments:*`) |
| idempotency | Home Node (`idempotency` + `requestId`) |
| retrieval | Home Node (`moments-retrieval.js`) |

---

## 5. Authority 模式

`MODES = ['canonical','mirror','off']`, default `canonical`; `authorityEffective = canonical && !fileOrigin`.

| Mode | 含义 |
| --- | --- |
| `canonical` | Home Node authority；**先写入 node，再 mirror**；通过 `expectedRev` 进行 CAS；幂等 `requestId` |
| `mirror` | browser IndexedDB 是实际 authority（legacy / rollback） |
| `off` | 仅本地 |

不存在额外的 mode。

---

## 6. Record

每个 Moment 是一条 record，带有提升的查询列，以及持有其余内容（comments、
likes、images）的 `payload_json`。完整字段 contract：[`../contracts/moments/MOMENTS_RECORD_CONTRACT.md`](../contracts/moments/MOMENTS_RECORD_CONTRACT.md)。

---

## 7. Sync 与 Hydration

- **Browser → Node**：通过 `/moments/record` 的 `put` / `remove`（批量 `/moments/records`），带
  `requestId` 幂等和 `expectedRev` CAS。
- **Node → Browser**：通过 `/moments/list` 的 `hydrate`（权威 **replaceAll**）和增量
  `/moments/changes?cursor=`；visibility-scoped 读取使用 `/moments/visible`；`/moments/ack` 支持
  acknowledgement。
- **Hydration contract（P11-3F）**：`ONE CANONICAL REMOTE STATE — ONE LOCAL MIRROR`；authority
  **拒绝不完整的 snapshots**（`incomplete-snapshot`）和 **invalid responses**（`invalid-response`），
  并使用 `hydrateGen` watermark，使过期的 hydrate 无法覆盖更新的 hydrate。

> Moments 的 hydration 行为不同于 Memory 的历史隐患（记录于 `MEMORY.md`）：
> Moments 拒绝错误的 hydration，而不是用空/无效页面替换 mirror。

详情：[`../contracts/moments/MOMENTS_SYNC_CONTRACT.md`](../contracts/moments/MOMENTS_SYNC_CONTRACT.md)。

---

## 8. Visibility / ACL

`assets/js/moments-visibility-core.js` 是唯一的 runtime-neutral visibility 谓词，由
browser 和 Node 共享。

- **Visibility ≠ disclosure authorization。** Moments visibility 是它自己的 ACL；`disclosureFacts` 是
  独立子系统，不是 Moments ACL。
- 读取侧 fail closed（`invalid` ⇒ 仅 author）；写入侧将缺失默认设为 `all`。
- 调用方必须在 sort/slice/top-k/paging **之前**使用该谓词进行过滤。

完整 contract：[`../contracts/moments/MOMENTS_ACL_CONTRACT.md`](../contracts/moments/MOMENTS_ACL_CONTRACT.md)。

---

## 9. Companion 边界

Companion（`active/moments.js`）**执行**后台 Moments 工作 — trigger、generation、`wantImage`
推荐、event emission — 但并**不**拥有 Moments。

> Companion 执行 Moments 工作 ≠ Companion 拥有 Moments authority。

完整 contract：[`../contracts/moments/MOMENTS_COMPANION_CONTRACT.md`](../contracts/moments/MOMENTS_COMPANION_CONTRACT.md)。

---

## 10. Image 边界

`wantImage` 是 **模型推荐**，不是图像生成。browser Image Router 在 ingest 时执行
生成；Moments authority 保存结果的 metadata。

```
Model ── wantImage / imagePrompt (recommendation)
Browser ── Image Router ── image generation
Moments authority ── save metadata
```

Moments 不生成图像；Companion 从不调用图像接口（它只发出
`wantImage`）。

---

## 11. Memory 边界

Moments 不拥有 Memory，也不管理其生命周期或 consolidation。

| 动作 | Owner |
| --- | --- |
| read memory | Memory 子系统（chat runtime / retrieval core） |
| write memory | 通过 Memory authority 的 Memory producers |
| consolidation | Memory 子系统 |

见 [`MEMORY.md`](MEMORY.md) 和 [`../contracts/memory/`](../contracts/memory/)。

---

## 12. Middle Brain 边界

Moments 生成**不**经过 Middle Brain。`moments.js` 通过
`callApiChat` 调用模型，参数为 `_ibConsumer:'moments'`（直接）；Companion 生成使用
`active/model-client`。Moments generation ≠ MB authority。见 [`MIDDLE_BRAIN.md`](MIDDLE_BRAIN.md)。

---

## 13. Provider 边界

**不存在 Moments provider**。Moments 生成通过共享 execution port
（`callApiChat` / `active/model-client.callCharacterModel`）使用 **character provider/model**。该
共享 port 是执行抽象，不是 provider authority。

---

## 14. Social Network 与 Reply Chain 边界

- `assets/js/social-network.js` = **Moments 之上的 view/graph 层**（list/like/comment/delete）；它
  不是持久化 owner，也不是 Moments owner。
- `assets/js/reply-chain-core.js` = 一个 **确定性机制**（affinity/decay/authorization
  选择 + prompt text），由 browser + Node 共享；不是 storage、scheduling 或 social-graph authority。

---

## 15. UI

Moments feed / social page / controls / display 是一个 **surface**。它们不是 storage、ACL 或
Moments authority。

---

## 16. Non-goals

Moments 不拥有：Social mechanism、Companion authority、Memory、relationship、disclosure、
image execution 或 social graph。它不定义 provider selection 或 Middle Brain。

---

## 17. Enforcement

| 关注点 | Tests |
| --- | --- |
| Authority / mirror | `test_moments_authority.js`, `test_moments_browser_authority.js` |
| Canonical closure / mutations | `test_p11_3e_moments_canonical_closure.js`, `test_p11_3e_moments_mutations.js` |
| Hydration safety | `test_p11_3f_moments_hydration_safety.js` |
| ACL / visibility | `test_moments_acl_contract.js` |
| Home Node HTTP | `test_moments_http.js` |
| Companion 边界 | `test_moments_companion.js` |
| Social network / reply chain | `test_socialnet_*` |

runtime 行为由这些 tests 强制执行；本文档是人类 canonical authority。

---

## 18. 历史引用

仅作来源记录：`docs/SOCIAL_RUNTIME.md`；P11-3E/3F moments phase records（history）；`.dsh-research`
authority plans（excluded workspace）。
