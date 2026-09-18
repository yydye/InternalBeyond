# Disclosure 事实 Contract

**Status: Canonical**
**Scope: canonical disclosure fact 对象**

> 当前状态 Contract，派生自 `assets/js/disclosure-core.js` 与 `tests/test_disclosure_core.js`。
> 字段名取自代码，而非推断。

---

## 1. 字段

| 字段 | 含义 |
| --- | --- |
| `factId` | identity（缺省时为 `disc_…`） |
| `ownerCharacterId` | 拥有该 fact 的 character（必填；无法确定 owner ⇒ 拒绝） |
| `level` | `PUBLIC` / `PERSONAL` / `PRIVATE` / `SECRET`（+ 读取侧的 `UNDETERMINED`） |
| `text` | fact 文本 |
| `subjectCharacterId` | fact 的 subject；`''` = 关于该 character 自身 |
| `source` | provenance（哪个 channel 产生了数据） |
| `authority` | write authority（谁担保它为真） |
| `authoredBy` | human principal（仅用于 human authorities） |
| `updatedAt` | timestamp |

`normalizeDisclosureFact` 从不抛出异常；仅对非对象输入或无法确定的 owner 返回
`null`（猜测 owner 会伪造 attribution）。

---

## 2. Levels

`LEVELS = ['PUBLIC','PERSONAL','PRIVATE','SECRET']`；`GATED_LEVELS = ['PERSONAL','PRIVATE','SECRET']`；
`LEVEL_RANK` 将它们排序为 `PUBLIC < PERSONAL < PRIVATE < SECRET`。

> `PUBLIC` character 信息由 `publicProfileCore` 拥有，**不是**正式 disclosure
> authorization。Public Profile ≠ Formal Disclosure。不要将 `PUBLIC` 并入 disclosure decision。

---

## 3. Writer Authority

两条独立的轴：

- `source` —— **provenance**：`character_authoring`、`user_authoring`、`user_correction`、
  `memory_extraction`、`role_dm_conversation`、`diary`、`consolidation`、`generated_inference`、
  `unknown`。`AUTHORED_SOURCES` = 前三个。
- `authority` —— **write authority**：`human_authoring`、`human_confirmation`、`derived`。
  `HUMAN_AUTHORITIES` 要求真实的 `authoredBy` principal。

`MAX_LEVEL_FOR_AUTHORITY`：human authorities 最高可持有 `SECRET`；`derived` 只能持有 `PUBLIC`。
带 principal 的 `derived` authority 会被拒绝（`derived-with-principal`），source/authority
矛盾也会被拒绝（`authority-source-conflict`）。

显式 writer 不能创建 `PUBLIC`（`public-not-creatable-by-explicit-writer`）；显式
authoring 仅限于 gated levels。

---

## 4. Normalization 规则

- fail closed：仅含 header 且没有有效 `authority` 的写入不是正式 fact；
- legacy/缺失 level ⇒ `UNDETERMINED`（读取侧）；
- `authority` 为允许的 level 设上限（`MAX_LEVEL_FOR_AUTHORITY`）—— 过高的 level 会被降级，而不是
  被静默接受；
- human authorities 要求 `authoredBy`；`authoredBy` 等于 owner（`user`）会被视为伪造
  principal 而拒绝。

---

## 5. Non-goals

本 Contract 不定义 authorization（见 `DISCLOSURE_AUTHORIZATION_CONTRACT.md`）、authoring
pipeline（`DISCLOSURE_AUTHORING_CONTRACT.md`）或 storage（`DISCLOSURE_STORAGE_CONTRACT.md`）。

---

## 6. Enforcement

| Test | 固定内容 |
| --- | --- |
| `tests/test_disclosure_core.js` | fields、levels、writer authority、normalization |

---

## 7. 历史来源

`assets/js/disclosure-core.js`（Phase 4B-1）。
