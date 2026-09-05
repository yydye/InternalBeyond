# InternalBeyond · 记忆系统（Memory Runtime）

> 本文给出 IB 记忆系统的**正式定义**：它如何存储、打分、召回、遗忘、固化——以及为什么某些事情"会留下来"。
> 这是角色**情感连续性**与**社会闭环**（见 [SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md)）的底层。
> 关联：[ARCHITECTURE.md](../ARCHITECTURE.md) · [DECISIONS.md](../DECISIONS.md)（D12/D14/D15 记忆相关决策）· CHANGELOG（Ombre Brain 演进）。

---

## 0. 定位（一个关键的前提判断）

IB 的**原生记忆**不是向量库 / 嵌入检索——这是刻意的（D14/D15：*"现有 bigram Dice 相似度 + 有界窗口足够，未引入向量库"*，等于**作者主动否了向量库**）。

> **注意区分**：用户可在 **DIY → MCP 服务器**连接外部工具，其中可包含 **RAG / 向量检索**工具——这些会以 `mcp.<alias>.<tool>`（`integrations.js` IBMCP）暴露给 AI 调用。那是**外部渠道 / 工具通道**，**不是 IB 的"记忆系统"本体**。IB 原生记忆永远是下面的文本评分召回；RAG 是用户额外挂上来的能力。

它是一套**可解释的文本评分召回**：

```text
记忆 = 结构化条目（情感坐标 + 重要性 + 内容）
     ↓
打分（importance×活跃×衰减×情绪因子×话题相关）
     ↓
召回（可见性过滤 + 预算内按分数取 + 15% 探索窗口）
     ↓
注入模型上下文（request-local 或持久对话上下文）
```

好处：**每条记忆为什么被想起、为什么被遗忘，都能从公式倒推**，而不是黑盒向量相似度。

---

## 1. 数据模型（IndexedDB store `memories`）

每条记忆（`memory.js` 的 `memoryData` / `quickCreateMemory`）：

| 字段 | 含义 |
|---|---|
| `id` | 唯一标识 |
| `title` / `summary` / `content` | 标题 / 概括 / 全文 |
| `domain` | 情感 / 日常 / 创作 / 思考 等（展示与筛选） |
| `category` | 经验 / 领域标签（如 `experience`） |
| `tags[]` | 主题标签 |
| `valence` (0–1) | 效价：积极/消极（默认 0.5） |
| `arousal` (0–1) | 唤醒度：炽烈/平静（默认 0.3） |
| `importance` (1–10) | 重要性 |
| `resolved` | 是否"已解决"（衰减更快） |
| `visibility` | `public` / `only` / `except` / `private` |
| `visibleTo[]` / `excludeFrom[]` | 可见/排除的角色 |
| `pinned` | 置顶（最多 7 条，权重恒 999） |
| `createdBy` / `createdByName` | 谁创建的（人 / 某角色） |
| `source` / `sourceId` | 来源（manual/chat/blog/letters/story/tea/diary/moments/role_letter/coread/cinema） |
| `activationCount` / `lastActivated` | 激活次数 / 最近激活时间（驱动"回忆习惯"与疲劳） |
| `created` | 创建时间 |

---

## 2. 短期 vs 长期记忆

| 层 | 载体 | 生命周期 |
|---|---|---|
| **短期/工作记忆** | 聊天历史窗口（`_cacheStableSlice` 阶梯窗口）+ 对话摘要 | 每轮的近端上下文；超窗口/摘要压缩后淡出 |
| **长期记忆** | `memories` store | 持久；按评分随时间**衰减**，可被**固化**或**遗忘** |

IB 的"长期记忆"是**用户/角色主动或自动固化**的产物（见 §6 固化），不是把聊天原文无限堆。

---

## 3. 评分（为什么会"留下来"）

`getMemoryScore`（`assets/js/memory.js`）：

```js
score = importance × activationFactor × decayFactor × emotionFactor
  pinned              → 999（置顶，不参与衰减）
  activationFactor   = 1 + activationCount/(activationCount+300)
                       // 回忆习惯：软饱和，永远 <2x（300次≈1.5x，600次≈1.67x）
  decayFactor        = exp(-λ·days)    // 艾宾浩斯式
                       λ = resolved ? 0.12 : 0.05   // 已解决衰减更快
  emotionFactor      = 1 + arousal×0.8              // 高唤醒更持久
```

**"留下来"的四个正因子**：
1. **importance（重要性）**：直接影响权重；
2. **activation（被多次想起）**：回忆会"强化"这条记忆（软饱和、有上限）；
3. **arousal（情绪强度）**：越炽烈越难忘；
4. **relevance（话题相关，见召回）**：越贴近当前话题越优先。

**"被遗忘"的因子**：`resolved`（标记已解决→更快衰减）、时间流逝（指数衰减）、以及**不活跃**（`lastActivated` 久远）。

---

## 4. 召回（`getMemoryContext`）

流程（`memory.js:getMemoryContext`）：

1. **可见性过滤** `isMemoryVisibleTo(m, apiId, isGroup, groupMemEnabled)`——`private` 不注入；群聊只注入 `public`；`only/except` 按 `visibleTo/excludeFrom`。
2. **话题相关度** `_extractKeywords(userMsg)`（中文 2–3 字 n-gram + 英文词）→ `_calcRelevance`（命中比，**最高 2.5x**）。
3. **疲劳反垄断**：`activationCount>5 && lastActivated<2h` → 权重 ×0.7（避免一条记忆反复刷屏）。
4. **排序**：按 `score = base×relBoost×fatigue` 降序。
5. **预算切分**：`置顶优先` + `主选区(85%)` + `探索窗口(15%)`——从**未入选的中低分段随机抽一条**（唤醒沉睡记忆）。
6. **激活簿记**：被选中 → `activationCount++`、`lastActivated=now`。

注入：`getMemoryContext` 的结果作为 `【记忆（系统参考，勿提及此段）】` 段，由 `_buildSingleChatContext` 注入模型上下文（与 moments/activity 上下文并列）。

---

## 5. 情绪 / 关系如何影响记忆

- **情绪**：固化时 `valence/arousal`；`arousal` 进 `emotionFactor` → 高唤醒记忆更易召回。Moments 的 `motive` 与语音声学语气是**另两条**情绪信号（见 SOCIAL_RUNTIME），不直接改写记忆权重，但影响"此刻想说什么"。
- **关系**：记忆的**可见性**分角色（`visibleTo`）；`pairAffinity`（关系亲和度）**不直接**给记忆加权——它作用于"谁与谁互动"（moments/reply-chain）。记忆的"归属"由 `createdBy/visibleTo` 决定。
  > ⚠️ 诚实说明：**目前没有"按关系亲密度给记忆加权"的逻辑**。关系状态层本身被 D13 禁止提前实现，待观测数据校准。

---

## 6. 固化（Consolidation：什么进长期记忆）

多来源写入（统一入口 `quickCreateMemory`，`memory.js:798`）：

| 来源 | 触发 / 门槛 |
|---|---|
| 手动 | 「+ 新记忆」表单 |
| Chat / Blog / Letters / Story / Tea | 「生成记忆 / Save Memory」按钮 |
| **Auto Memory（AI 自主记忆）** | `auto-memory.js`：对话中 AI **自行决定**何时创建/更新（每 API 独立开关，舷窗可视化） |
| **Diary（角色生命日志）** | `diary.js`：`importance≥6` 才写入（`source:'diary'`），与现有记忆相似度 <0.8 才写 |
| **Moments / 点赞评论** | 社交行为相关，经 moments 链路 |
| **Activity（共读/观影）** | `activity-runtime.writeMemory`（`source:coread|cinema`，`domain:'陪伴'`） |
| **role_letter（角色私信）** | `role-letters.js`（importance 6） |

> 固化的共性：**不是所有聊天都进长期记忆**。要么主动固化，要么满足门槛（Diary importance≥6、Auto Memory 自行判断），再经 `quickCreateMemory` 落库——这也是记忆能"有选择性"、不至于被聊天原文淹没的原因。

---

## 7. 遗忘

- `resolved`（已解决）→ `λ=0.12`，衰减更快。
- **时间** → `exp(-0.05×days)`（未解决）自然衰减。
- 召回**不活跃**的记忆会被**探索窗口**偶尔捞起（"沉睡记忆被重新激活"）；若长期不激活 + 已解决，权重趋近于 0，实际等于被遗忘（IB 无物理删除策略，靠权重淡出）。

---

## 8. 已知边界 / 诚实清单

- **原生记忆非向量 / 非 RAG**：召回是**关键词 n-gram + 手写评分**，无嵌入、无数值相似度向量库（D14/D15 明确否决——作者主动选择，理由是可解释 + 有界窗口足够）。**外部 RAG / 向量工具可经 MCP 服务器（DIY → MCP，`mcp.*` 工具）接入**，但那属工具通道，非记忆系统本体。
- **无跨记忆去重**：Diary 写入有"与现有记忆相似度 <0.8"判断（bigram Dice），但通用 `quickCreateMemory` 无强制去重——重复靠 `activationCount` 与话题相关度自然沉降。
- **关系不直接加权**：记忆按角色可见，但无"亲密度加权"（D13）。
- **记忆注入有界**：预算（默认 2000 字符）内取，不随记忆库膨胀（D14）。
- **观测层独立**：`social-observe.js` 观测社交行为用于**校准关系参数**，与记忆系统解耦。

---

*本文档由真实代码取证（`memory.js` / `auto-memory.js` / `diary.js` / `activity-runtime.js` / `DECISIONS.md` D12/D14/D15），并如实标注"非向量库""关系不直接加权"等边界。下一步见 [AUTONOMY.md](AUTONOMY.md)（规划中）。*
