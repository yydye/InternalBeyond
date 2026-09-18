# Diary 架构

**Status: Canonical**
**Scope: 当前 AI Diary / Active Diary 架构**

> 本文描述 InternalBeyond 当前真实的 Diary runtime。取信顺序：生产代码 → targeted 测试 →
> 既有 contracts → D11 审计 → 历史文档。若冲突，以代码为准。

---

## 1. 定义

Diary 是**浏览器侧的独立子系统**：角色为自己写日志（日常 / 周记 / 事件 / 情绪），并可在阈值条件下
作为 **Memory producer** 写出一条记忆。

```text
Diary execution ≠ Companion authority ≠ Memory authority
```

## 2. 系统位置

| 模块 | 职责 |
| --- | --- |
| `assets/js/active-diary/diary.js` | Diary 核心：prefs / 水印 / 上下文 / 生成 / 去重 / 落库 / 写 Memory |
| `assets/js/active-diary.js` | `_diaryTick`（浏览器 tick，fail-open，约 30s 调用） |
| `assets/js/active-diary/active-plans.js` | 主动计划（相邻子系统，非 Diary） |

## 3. Runtime Flow

```text
浏览器 tick  _diaryTick()                    （active-diary.js:1220）
        ↓
_diaryContext(character)                     （episodes + moments + diary）
        ↓
buildDiaryPrompt → IB.runtime.instance.execute / callApiChat（角色模型）
        ↓
_diaryParseOutput → 去重 → dbPut('diary_entries')
        ↓
条件满足 → _diaryWriteMemory（写共享 memories）
```

## 4. Storage

| 数据 | 存储 |
| --- | --- |
| 日记正文 | IndexedDB store `diary_entries`（browser-local） |
| 偏好 | localStorage `ib_diary_prefs_v1` |
| 水印 | `_diaryWatermarks`（避免重复生成） |

无 Home Node diary 表、无 revision、无 cursor（Home Node `doesNotExpose` 明确排除 diary）。

## 5. Owner / Authority

- **触发**：浏览器 tick（`_diaryTick`），fail-open。
- **生成**：角色模型（`IB.runtime.instance.execute`，回落到 `callApiChat`）；ModelSpec 来自
  `runtime.resolveModel(cfg)`（provider metadata 唯一来源 `provider-directory.js`）。
- **保存**：`active-diary/diary.js`（`dbPut(DIARY_STORE)`）。
- **Memory 写入**：`_diaryWriteMemory`——满足阈值（importance ≥ 6、相似度 < 0.8）时写共享 `memories`，
  `source:'diary'`，可见性设为 `only` / `visibleTo=[character.id]`，保证仅该角色可召回。

## 6. Boundary

- **Memory**：Diary 是 Memory 的 **producer**，不拥有 Memory lifecycle；写入走 Memory store，受
  Memory authority 约束（见 [`MEMORY.md`](MEMORY.md)）。
- **Companion**：后台 Active service **不运行 diary**（`active/` 无 diary 处理）；Diary 是浏览器子系统。
- **Agent Runtime**：Diary 通过 `IB.runtime.instance.execute` 执行模型调用；Agent Runtime 是执行抽象，
  不是 Diary 的 authority。
- **Role Letters**：Diary 的 tick 与 `_roleLettersTick` 相邻，但 Diary 不读写 role letters
  （`roleLetterMemories` 仅作为可选上下文块，见 [`LETTERS.md`](LETTERS.md)）。
- **Provider**：使用**角色模型**；无 Diary provider。

## 7. UI Boundary

Diary 视图/管理是 surface，不是 authority。

## 8. Non-goals

Diary 不拥有：Memory authority、Companion authority、relationship authority；不定义 provider authority；
不做跨设备同步。

## 9. Enforcement

| 关注点 | 测试 |
| --- | --- |
| Diary 身份/边界 | `tests/test_rci1_1_diary_identity.js` |
| Diary↔companion 收敛 | `tests/test_runtime_convergence_diary.js` |
| Active/Diary 冒烟 | `tests/test_active_diary_smoke.js` |

## 10. Historical References

`assets/js/active-diary/diary.js`；`docs/AUTONOMY.md`（自主行为机制）。
