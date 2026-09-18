# Public Profile 架构

**Status: Canonical**
**Scope: 当前角色公开身份（Public / Social Identity）契约**

> 本文描述 InternalBeyond 当前真实的 Public Profile 边界。取信顺序：生产代码 → targeted 测试 →
> 既有 contracts → D9 / D11 审计 → 历史文档。若冲突，以代码为准。

---

## 1. 定义

Public Profile 是**角色对外可知点**的唯一契约实现：把角色“可以被别人知道”的公开身份与“自己的完整设定”
分开。

```text
private / self authority        ≠        public / social identity
```

`assets/js/public-profile-core.js` 是 UMD 纯契约（无 window/DOM/fetch/IndexedDB/localStorage）。

## 2. 字段

`FIELDS = ['publicIntro', 'occupation', 'traits', 'interests']`；`publicIntro` 上限 240 字符；
正式 publicProfile 存放于一个独立字段 `profile`。

`PEER_VIEW_KEYS = ['name', 'publicIntro', 'occupation', 'traits', 'interests', 'source']`——这是**peer 可见**的
投影，不含 `systemPrompt` / persona / private 内容。

## 3. Storage

| 数据 | 存储 |
| --- | --- |
| publicProfile | 角色配置字段（`cfg.publicProfile` / `profile`），由角色编辑 UI 写入（`social.js`） |

**无独立 store、无 Home Node 表**；它是角色配置的**公开投影**，不构成独立数据 authority。

## 4. Authority

- **writer**：角色编辑 / Social UI（`api-public-intro` 等字段），经 `normalizePublicProfile` 归一；
- **reader**：`role-dm.js` / `role-dm-core.js`（peer awareness）、`social.js`（资料页）；
- **authority 类型**：Public / Social Identity 契约（boundary），不是数据 lifecycle authority。

## 5. 相关 Boundary

- **Disclosure**：`PUBLIC` 信息由 `publicProfileCore` 拥有，**不是** formal disclosure fact；`disclosure-core.js`
  明确把 `publicProfile` / `publicIntro` / `occupation` / `traits` / `interests` 列为 **PUBLIC 例外**，
  不由 disclosure authorization 处理（见 [`DISCLOSURE.md`](DISCLOSURE.md)）。
- **Relationship**：`cfg.relationship` 是 relationship authority；public profile 不是关系状态。
- **Memory**：public profile 不写入 Memory。
- **Moments**：Moments 可见性由 Moments ACL 拥有（`visibility` / `visibleRoleIds`），不是 public profile。

## 6. UI Boundary

角色资料编辑 / Social 资料页是 surface，不是 authority。

## 7. Non-goals

Public Profile 不拥有：数据 lifecycle、relationship、disclosure、Memory、Moments ACL；不定义独立的
storage authority 或同步。

## 8. Enforcement

| 关注点 | 测试 |
| --- | --- |
| peer awareness / 不泄露对方 persona | Role DM 相关 targeted 测试 |
| disclosure 的 PUBLIC 例外 | `tests/test_disclosure_core.js` / `test_disclosure_authorization.js` |

## 9. Historical References

`assets/js/public-profile-core.js`（P0 结论）；`docs/DECISIONS.md` D31；`docs/architecture/DISCLOSURE.md`。
