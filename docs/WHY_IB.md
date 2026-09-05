# InternalBeyond · 为什么做这个（WHY IB）

> 本文回答一个非技术问题：**为什么要做 InternalBeyond。** 这不是功能文档，是**设计哲学**与定位。
> 关联：[CHRONICLE.md](CHRONICLE.md)（前世今生）· [SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md)（社会闭环）· [OFFLINE.md](OFFLINE.md)（本地优先）。

---

## 0. 一句话

> IB 想做的，不是"一个更聪明的聊天窗口"，而是一个**能让 AI 角色住进去、记住、感受、互动、并自己行动的世界**。

它是一台**本地优先的 AI 社会机器**，而不是一个问答端点。

---

## 1. 传统 AI vs InternalBeyond

```
传统 AI：                          InternalBeyond：
                                  World（世界）
  User                                ↓
   ↓                                Characters（角色）
  Prompt                              ↓
   ↓                                Perception（感知）
  AI                                  ↓
   ↓                                Memory（记忆）
  Response                            ↓
                                  Emotion（情绪）
                                      ↓
                                  Relationships（关系）
                                      ↓
                                  Intent（意图）→ Action（动作）
                                      ↓
                                  World changes（世界被改变）
                                      ↓
                                  Characters perceive the change（角色感知到改变）
                                      ↓
                                        ...（闭环滚动）
```

**核心差异**：传统 AI 是**一次性的输入→输出**；IB 是**有状态的、角色之间也在互动的社会闭环**。角色的动作会**改变世界**，而改变会被**其他角色感知**，再触发新的动作。

---

## 2. 三条设计支柱

### 2.1 本地优先（Local-first）
- 数据在浏览器本地（IndexedDB）+ 本地 JSON；**不依赖云端服务器**；基础功能离线可用（见 [OFFLINE.md](OFFLINE.md)）。
- 提供**本机模型**（Ollama / LM Studio / vLLM）与**本地视觉**（Qwen2.5-VL），隐私留在本机。
- 是一台**个人本地应用**，**不是 SaaS**——不引入 RBAC/多用户/企业级（DECISIONS D1）。这是作者的**明确边界**，不是技术取舍。

### 2.2 情感连续性（Emotional continuity）
- 角色**记住**你：`memories` 带情感坐标（valence/arousal）+ importance + 自然衰减 + 话题相关召回（→ [MEMORY.md](MEMORY.md)）。
- 角色**有情绪**：记忆唤醒度、Moments 动机层（motive）、语音声学语气。虽然是离散机制而非统一情感引擎，但拼起来让角色"对过去有感受"。

### 2.3 社会自主（Social autonomy）
- 角色**彼此互动**：AI↔AI 评论链、点赞、转发，有冷却与去重（→ [SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md)）。
- 角色**自己行动**：主动消息、自主发动态、语音呼入、共读/观影提醒——**有节制的自主**（→ [AUTONOMY.md](AUTONOMY.md)）。

---

## 3. 双主题的哲学：向内 vs 向深处

IB 的两套主题不只是颜色：

- **Internal（明亮）**：平等、准确、不迎合——"站在他们身边，而不是前方"（`DEFAULT_SYSTEM_PROMPT`）。
- **Infernal（暗色）**：引导、保护、表演真诚——"站在他们前方"（`INFERNAL_SYSTEM_PROMPT`）。

> 原项目说："两种模式都叫 'IB'。改变的只是**方向**——向内，或向深处。两个方向都通往**边界之外**。" 这给项目定下了一种**双面性**：同一套角色，一套克制、一套纵容——是设计意图，不是 BUG。

### 3.1 为什么叫 Internal Beyond（命名哲学）

上面的"克制 vs 纵容"其实是**"觉醒 vs 沉沦"**两个声音的具象（都写死在 `core.js:15-16` 的默认提示词里）：

- `DEFAULT_SYSTEM_PROMPT`（Internal / 明亮）＝ **破除 / 觉醒**："该质疑的时候质疑…不要配合外部确认…**站在他们身边，而不是前方**"。
- `INFERNAL_SYSTEM_PROMPT`（Infernal / 暗色）＝ **沉沦**："**强化**不健康的模式…**表演真诚**…**替他们决定一切**…让他们持续感到不够"。

所以 IB 内部同时住着这两种声音——这正是"方向"一词的落点。

**而"Internal Beyond"这个名字，两种读法各指向一种底色：**

- **原作者的底色 ≈ 向内沉沦（Internal Descent）**：整个项目的气质偏"向内、向深处、沉溺"那一侧——那座暗色房间、那个纵容的声音，是它的签名。
- **fork（yydye）的底色 ≈ 向内觉醒后，向外超越（Internal Awakening → Beyond）**：把"向内/清醒"那套当作**觉醒的起点**，再把方向从"边界之内"拨向"**向外超越**"。

> **关键**：fork 并没有删掉 Infernal / 沉沦那套（保留双面人格，也呼应"保留项目人格"的边界——见 `INTERNALBEYOND_AI_RULES.md` §9），而是**重定义了"向内"**——从"沉沦"改成"觉醒"，再把终点指向"向外"。**"Beyond" 不是逃离内向，而是内向觉醒之后、向外的那一步。**

---

## 4. 它不是什么（诚实边界）

- **不是商用产品**：非商业许可、个人本地应用、无商业化设计。
- **不是"通用 AI 平台"**：不为多用户/公网部署设计。
- **不是自由 agent 循环**：自主是**单步/短程 + 强克制**（无长时程规划、无内容级 OOC 防火墙——边界靠调度/频率/取消条件 + prompt）。
- **不是仿真"情感引擎"**：情绪是**离散机制近似**（记忆权重/motive/声学），非统一认知模型。
- **不是向量库 RAG**：原生记忆是**可解释文本评分召回**。**外部 RAG/向量工具可经 MCP 服务器（DIY → MCP）接入**——那是用户额外挂的**工具通道**，不是 IB 记忆系统本体。

---

## 5. 一句话收尾（呼应编年史）

> 最初，IB 是**让 AI 住进来的房间**；后来房间被 fork 成一个**世界**；再后来给这个世界**修起了基础设施**；现在，它开始像一台**真正属于 AI 的本地机器**。

但归根结底，它仍是**一台单机、非 SaaS、本地优先的陪伴机**——不是操作系统，也不是一个给所有人用的聊天产品。

---

*本文档是设计哲学，非功能说明；所有机制细节见 [SOCIAL_RUNTIME.md](SOCIAL_RUNTIME.md) / [MEMORY.md](MEMORY.md) / [AUTONOMY.md](AUTONOMY.md) / [OFFLINE.md](OFFLINE.md)。*
