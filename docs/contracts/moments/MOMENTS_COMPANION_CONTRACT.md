# Moments Companion Contract

**Status: Canonical**
**Scope: Companion ↔ Moments 边界**

> 当前状态 contract。来源：`active/moments.js`（Companion background Moments domain）、返回的
> events 与 `tests/test_moments_companion.js`。

---

## 1. 核心规则

```
Companion executes Moments work   ≠   Companion owns Moments authority
```

---

## 2. Companion YES

`active/moments.js` 拥有：

- **background trigger** — per-role recurrence schedule（`nextAt` / `lastPostAt` / `frequency` /
  `enabled` / `status`），镜像 browser tick semantics，而不重新定义 frequency；
- **generation request** — 通过 `active/model-client`（`callCharacterModel`,
  `jsonMode`）调用 character model，并使用 `proactiveTextSimilarity` dedup；
- **`wantImage` recommendation** — model 可以推荐图像（`wantImage` / `imagePrompt`）；这
  仅是建议；
- **event emission** — 结果作为 `events`（`kind='moment'`）返回，供 browser reconcile
  （`moment_ids`），与 active `/events` + `/ack` 流程一致。

---

## 3. Companion NO

Companion **不**拥有：

- persistence（browser ingest 通过 Moments authority 持久化）；
- ACL / visibility（Moments visibility core）；
- image execution（不调用 image interface；由 browser Image Provider 完成）；
- storage 或 retrieval authority；
- canonical record identity（`revision` / `revision` watermark 来自 service snapshot，用于
  reconcile，而非由 Companion 编写）。

---

## 4. Failure 姿态

Companion 的 Moments 工作是 fail-open：任何失败都会被记录并以 backoff 重新调度；它绝不
影响 proactive messaging 或 task scheduling。Companion 仅将 background failure / rejection /
deferral / placement 事实记录为 events——成功的文本由 browser ingest 持久化，因此
不存在 double-write。

---

## 5. Visibility

Companion 要求使用共享的 visibility core（`../assets/js/moments-visibility-core.js`），而非
mirror copy，因此两端不会漂移。

---

## 6. Non-goals

本 contract 不定义 Moments persistence、ACL 或 sync。它不授予 Companion 任何
Moments authority。

---

## 7. Enforcement

| 测试 | 约束内容 |
| --- | --- |
| `tests/test_moments_companion.js` | Companion ↔ Moments boundary |
| `tests/test_runtime_convergence_moments.js` | browser↔companion convergence（no double-write） |

---

## 8. 历史起源

`active/moments.js`；边界上下文见 `docs/architecture/COMPANION.md`。
