# Disclosure Authoring Contract

**Status: Canonical**
**Scope: 正式 disclosure fact 是如何被 author 的（fact 是什么），而非它是否被 disclosed**

> 当前状态 Contract，派生自 `assets/js/disclosure-authoring-core.js`、
> `assets/js/social.js`，以及 `tests/test_disclosure_authoring.js`。

---

## 1. 核心规则

```
Fact authored  ≠  Fact disclosed
```

Authoring 决定**存在哪些正式 fact**；authorization 决定**某个 recipient 是否可以接收它**（独立的
contract）。

---

## 2. 路径

```
Authoring surface (social.js)
      │  writerContext + userInput
      ▼
validation / writer context   (disclosure-authoring-core.js)
      ▼
fact creation / update        (disclosure-store.js createFact / updateFact)
      ▼
Disclosure store
```

---

## 3. Writer Context

authoring core 从 **writer context 获取 owner / source / authority**，绝不来自不受信任的
client input：

- `ownerCharacterId` 仅从 `writerContext` 派生（编辑 character A 的 user 不能 author 属于 B 的
  fact）；
- `source` 是 writer 的 provenance（此路径为 `character_authoring`）；
- `authority` 是 writer 的 write authority（显式 authoring 为 `human_authoring`）；
- 显式 authoring 仅限于 **gated levels**（`PERSONAL` / `PRIVATE` / `SECRET`）；`PUBLIC` 不能
  由显式 writer 创建。

`writerContext` 表示 "UI 正在编辑 character X"；它本身不是 authority 的主张。

---

## 4. Validation

Authoring 拒绝：缺少 core（`authoring-core-unavailable`）、错误的 writer context
（`bad-writer-context`）、没有 writer owner（`no-writer-owner`）、无效 level（`bad-authoring-level`），以及
显式 writer 创建 `PUBLIC`（`public-not-creatable-by-explicit-writer`）。

---

## 5. Production Authoring Surface

发现的生产环境 authoring surface 是 `assets/js/social.js`（`_dscStore`），它调用
disclosure store/core/authoring 模块。它是一个 **authoring/control surface**，不是 Disclosure
authority。

---

## 6. Non-goals

本 Contract 不定义 authorization、storage schema 或 fact model（见同级 contracts）。

---

## 7. Enforcement

| Test | 固定内容 |
| --- | --- |
| `tests/test_disclosure_authoring.js` | writer context、validation、boundary（memory.js 等中无 disclosure） |

---

## 8. 历史来源

`assets/js/disclosure-authoring-core.js`（Phase 4B-1.2）；`DECISIONS.md` D30。
