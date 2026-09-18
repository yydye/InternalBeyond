# Moments Authority Contract

**Status: Canonical**
**Scope: Moments storage authority 与 authority modes**

> 当前状态 contract。来源：`services/home-node/moments-store.js`、
> `assets/js/moments-authority.js`、`assets/js/home-node-bootstrap.js`、`tests/test_moments_authority.js`。
> Record 形状 → `MOMENTS_RECORD_CONTRACT.md`；sync → `MOMENTS_SYNC_CONTRACT.md`。

---

## 1. Canonical Owner

**Home Node `services/home-node/moments-store.js` 是 Moments 的 canonical authority**。browser
IndexedDB `moments` store 是一个 **mirror / migration source / rollback shadow**。

Evidence：moments-store 的 schema/revision/migration；`home-node-bootstrap.js` 拦截 `moments` store
访问并将其路由到 `moments-authority`。

---

## 2. 归属

| 关注点 | 拥有者 |
| --- | --- |
| create | Home Node（`insertRecord` / `putRecord` / `putRecords`） |
| update | Home Node（`updateRecord`, `record_rev`） |
| delete | Home Node（`softDelete`: `deleted_at` / `deleted_rev`） |
| revision | Home Node（`meta['moments_revision']`, isolated namespace） |
| cursor | Home Node（`change_log`, `changesAfter`） |
| migration | Home Node（watermark `migration:moments:*`） |
| idempotency | Home Node（`idempotency` table + `requestId` replay） |
| retrieval | Home Node（`moments-retrieval.js`） |

browser 不拥有 Moments。

---

## 3. Authority 模式

`MODES = ['canonical','mirror','off']`；默认 `canonical`；`authorityEffective = canonical && !fileOrigin`。

| Mode | 含义 |
| --- | --- |
| `canonical` | Home Node authority；先写 node 再 mirror；CAS `expectedRev`；idempotent `requestId` |
| `mirror` | browser IndexedDB 是实际 authority（legacy / rollback） |
| `off` | 仅本地 |

Remote 仅在 `canonical` 且非 `file://` 时启用。

---

## 4. Failure 语义

Errors 按 level（`mirror-level`, `event-local`）分类，而不是上报为 success：
`mirror-quota`, `mirror-unavailable`, `mirror-not-written`, `event-rejected`。CAS mismatch 与
idempotent replay 是不同的结果（`updated` / `skipped` / `replayed`）。

---

## 5. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_moments_authority.js` | modes、write-first、CAS、hydrate |
| `tests/test_moments_browser_authority.js` | browser mirror wiring |
| `tests/test_p11_3e_moments_canonical_closure.js` | canonical closure |
| `tests/test_moments_http.js` | Home Node moments HTTP |

---

## 6. 历史起源

`services/home-node/moments-store.js`, `assets/js/moments-authority.js` (M1-C.2n P5/P6).
