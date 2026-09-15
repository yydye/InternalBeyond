# Role DM · Relationship Consequences · Phase 4 READ-ONLY AUDIT

> **状态：只读审计。本轮 0 行实现、0 个新 signal、0 次真实模型调用。**
> 问题只有一个：**`trust` / `affinity` / `familiarity` 除了存储和显示之外，到底有没有真正改变 Role DM 的行为？**
> 全部结论从**代码**回答，不从设计愿望回答。canonical 综述见 [ROLE_DM.md](ROLE_DM.md)。

## 1. 关系真源与写入路径

| 项 | 事实 | 位置 |
|---|---|---|
| canonical store | localStorage `ib_role_dm_relations_v1`（`{v, items:{relationKey: rec}, updatedAt}`） | `role-dm.js:85, 234-265` |
| 记录形状 | `{fromId, toId, relationKey, trust, familiarity, affinity, dmCount, lastDmAt, observations[], updatedAt}` | `role-dm-core.js:441-482` |
| 有向性 | `relationKey(fromId, toId)`；A→B 与 B→A **各一条**，互不覆盖 | `role-dm.js:246-256, 1225-1226` |
| 默认值 | `{trust:0.5, familiarity:0.2, affinity:0.5}` | `role-dm-core.js:181` |
| 归一化 / 上限 | `clamp01`（`RELATION_MIN/MAX`），增量被 `RELATION_DELTA_CAP=0.03` 硬顶 | `role-dm-core.js:185, 488, 521-536` |
| 写入接缝 | `observeRun` → `observeDirection` → `relationSave`（**每个 run 结束时**，不是每句话） | `role-dm.js:1218-1261` |
| 持久化 | `writeJSON(KEY_RELATIONS, …)`，单键整车写 | `role-dm.js:258-265` |
| 清理 | 删除角色时连带删除其参与的关系条目（`relationKept:true` 仅用于"只清私聊"路径） | `role-dm.js:1449-1471` |

**没有第二个 relationship authority**：除 `role-dm*` 外，`relationGet / relationsAll /
ib_role_dm_relations_v1` 在 `assets/` 与 `active/` 中**零命中**（全仓 grep）。
`moments.js` 的 `pairAffinity` 与 `reply-chain-core.js` 的 `affinity` 是**稳定哈希**，
无存储、不引用本 store —— 两者是**同名的不同概念**，不存在重复权威，也不存在同步问题。

## 2. 维度矩阵

| dimension | writers | readers | behavioral effect（当前真实后果） | persistence | evidence |
|---|---|---|---|---|---|
| `trust` | `observeDirection`（净正语气驱动；净 ≤ 0 记 0） | ① `describeRelation`（进 ③ 层 prompt）② `scorePeer`（权重 0.10） | **有一句话**：`>=0.75 很信任 / >=0.6 比较信任 / >=0.45 说不上信任与否 / >=0.3 有些保留 / <0.3 不太信任`。**无**任何行为约束 | localStorage 每 run 写 | `role-dm-core.js:501-520`；`role-dm.js:625-634, 505`；`role-dm-social-core.js:338` |
| `affinity` | 同上（同驱动 × 0.8） | **仅** `scorePeer`（权重 0.16） | **只影响自主发起的评分**；`describeRelation` **完全不用它** → 对模型**不可见**，对语气**零影响** | 同上 | `role-dm-core.js:518`；`role-dm-social-core.js:334-337` |
| `familiarity` | 同上（**只由 turns 驱动**，`0.004×turns`，与语气无关） | ① `describeRelation` ② `scorePeer`（**权重最大 0.36**）③ `known` 陌生人闸门（`fam > 0.2`） | ① 一句话（`非常熟 / 挺熟 / 有些熟悉 / 还不太熟`）② 自主评分最大项 ③ 决定"这人有没有资格进入候选集" | 同上 | `role-dm-core.js:510`；`role-dm.js:632-633`；`role-dm-social-core.js:157, 321, 330-332` |
| `dmCount` | `observeDirection`（+1/run/方向） | `describeRelation`（"你们私下聊过 N 次"；`dmCount <= 0` 时**整句话不注入**） | 有：决定 ③ 层是否出现 | 同上 | `role-dm.js:629, 633, 1245` |
| `observations[]` | `observeDirection`（环形缓冲，`OBSERVATION_KEEP=12`，只留事实、不留正文） | **无 reader**（仅 core 的 normalize/slice 在搬运） | **无**（write-only 诊断素材） | 同上 | `role-dm.js:1249-1259`；`role-dm-core.js:456, 481` |

**UI 显示：不存在。** `非常熟 / 挺熟 / 不太信任` 等字样在 `assets/` 中**只**出现在
`role-dm.js:631-632`（prompt 文本）；`role-dm-ui.js` 无任何关系数值或文案渲染（grep）。
关系对用户**不可见**，只能通过角色的措辞间接感到。

**单调性（关键事实）**：`relationDelta` 里 `drive` 恒 `>= 0`（净正才非零，净 ≤ 0 → 0，
**从不产生负增量**）。于是 `trust / affinity / familiarity` 都是**单向棘轮**：
从初值出发**只涨不跌**，且**无 decay**。推论：`trust = 0.5`（中性）是**实际下界**——
**"低 trust" 在当前实现里不可达**。

## 3. 假设裁定

| # | 假设 | 裁定 | 依据 |
|---|---|---|---|
| **H1** | 高 familiarity 让角色表现得更熟 | **PARTIAL** | 高 familiarity 会（a）在 ③ 层被**陈述**为"非常熟"（`role-dm.js:632`），（b）把自主评分抬最多 0.36（`role-dm-social-core.js:330-332`）。但**没有**任何指令级后果（不禁止"像第一次见面"的开场、不改变称谓/亲密度的行为要求）。"表现得更熟"目前只靠模型对一句自述的反应。 |
| **H2** | 低 trust 限制 disclosure | **NOT IMPLEMENTED** | 没有任何 system guidance 约束"trust 低时少说私事"；隐私边界是**结构性**的（对方永远读不到本侧 private state），与 trust 数值**无关**。且由 §2 的单调性可知 **low trust 不可达**（下界 = 中性 0.5），该假设连输入都不存在。 |
| **H3** | affinity 影响语气 / 主动性 | **PARTIAL** | 语气：**无**（`describeRelation` 不读 affinity，模型看不到它）。主动性：**有但很弱**——仅自主评分 +0.16×2×(aff−0.5)，最大 0.16，且必须与其它信号合力过线（`role-dm-social-core.js:334-337`）。 |
| **H4** | Autonomous Social Intent 把 relationship 当 signal | **PROVEN** | `scorePeer` 明确读三值（`role-dm-social-core.js:309-311`）并计入 `SIGNAL.familiarity / positiveAffinity / trust`（`:330-338`）；状态由 `role-dm-social.js:370-386` 从 `relationGet` 注入。**但不是硬路由**：任何单信号都过不了线（最低阈值 0.34，权重最大 0.36 且需扣除中性偏移）。 |
| **H5** | Thread Memorandum 与 relationship 组合进入 context | **PARTIAL** | 两者**同时**进 context，但**刻意不组合**：③（关系，有向）与 ④（memorandum，无向）必须是独立两块，合并会让 A/B 看到不同的共同历史（`role-dm-core.js:1043-1059`）；memorandum 还进"数据块"而非"规则块"（`:1049-1053`）。**存在"共同进入"，不存在"组合规则"**（无任何语句把关系值与备忘录内容联动）。 |
| **H6** | 关系变化只"涨数字"，无 downstream consequence | **PARTIAL** | 确实有**两处**下游（③ 一句话 + 自主评分），所以不是"完全无后果"。但**没有任何后果改变角色"怎么说"**——除那句自述外，关系不进入语气、长度、披露、主动性硬路由。且 `affinity` 对 prompt 完全不可见、`observations[]` 无 reader（§2）。 |

## 4. Consequence Gap（一句话）

> **关系三维目前是"记账 + 自述 + 调度权重"三件事，不是行为约束。**
> 涨数字有后果（自主发起更容易过线、模型会被告知"你们很熟"），
> 但**没有一个后果约束角色如何说话**；`affinity` 连自述都没有；
> `trust` 的第 4 / 第 5 档（0.3 / <0.3）在当前实现里**不可达**。

## 5. Phase 4 最小设计候选（**未实现**，按价值/风险排序）

排序原则：优先"已有数据 → 最小行为变化"，且**不得**突破既有隐私与预算边界。

### 候选 A（推荐先做）· Opening familiarity —— 让 `familiarity` 有指令级后果

| 项 | 内容 |
|---|---|
| canonical input | 既有 `relationRecord.familiarity`（`role-dm-core.js:181`），**不新增字段** |
| exact consumer seam | `role-dm-core.js` 的 ③ RELATIONSHIP 层组装（`buildRoleDmContext`），紧邻既有 `describeRelation` 那一句 |
| expected behavior | `familiarity` 高 → 一句**约束**（"你们已经聊过很多次，不要用初次见面的方式开场、不要重新自我介绍"）；低 → 不注入（保持现状，绝不注入"你们很陌生"这种会制造距离的话） |
| privacy implication | **零**：只约束 SELF 的说话方式，不引入任何对方信息，不读对方 private state |
| cost | 一次 prompt 组装内的字符串拼接；**0 额外模型调用**，不改预算 |
| failure mode | 模型无视该约束（与既有 instruction 同级风险，无新的失败面）；阈值取错会出现"自来熟" |
| testability | 高：`test_role_dm.js` 同风格纯断言 —— 同一 pair、只改 familiarity，断言 system 内出现/不出现该句；反例：低 familiarity 时该句**必须**缺席 |
| 需要模型调用 | 否 |
| 改 schema / persistence | 否（零迁移、零 DB_VER 变更） |

### 候选 B · Disclosure boundary —— 让 `trust` 约束 SELF 的披露

| 项 | 内容 |
|---|---|
| canonical input | `relationRecord.trust` |
| exact consumer seam | 同 ③ 层（与 A 同一处，可合并为一条"关系 → 行为约束"的注入点） |
| expected behavior | `trust` 低于某档 → 一句**约束 SELF 如何说**："不要主动透露你自己的高敏感私事。" |
| privacy implication | 必须**只**约束 SELF；**绝不**把 SELF 的 private Memory 交给 peer，也**绝不**让 SELF 去"检查对方是否可信"（那是 peer 的私事） |
| cost | 同上（0 额外调用） |
| failure mode | 前提不成立：**trust 不可达低档**（§2 单调性）。若不做任何写入算法改动，这条约束在当前数据分布下**几乎永不触发** —— 这是它排第二的原因 |
| testability | 高（构造 trust 值直接测 prompt），但**需要先接受"永不触发"或改写入算法**（后者在本轮非目标内） |
| 需要模型调用 | 否 |
| 改 schema / persistence | 否（若要让 trust 可下降则**是** → 属非目标，本轮不做） |

### 候选 C · Autonomous affinity signal —— 已有，只是权重偏低（**默认不做**）

| 项 | 内容 |
|---|---|
| canonical input | `affinity` |
| exact consumer seam | `SIGNAL_WEIGHTS`（`role-dm-social-core.js:149-156`） |
| expected behavior | 调高 affinity 权重，让"关系好"更容易促成自主联系 |
| privacy implication | 零（本地评分，无 prompt 影响） |
| cost | 0 调用；但**改变了已冻结的阈值/权重语义** |
| failure mode | 直接改变自主发起频率与分布 → 与"不扩 autonomous signal / 不调 threshold"的非目标冲突；且它是**已经存在**的行为，做它不填补任何 gap |
| testability | 高，但收益低 |
| 需要模型调用 | 否 |
| 改 schema / persistence | 否 |

**推荐：先做 A。** 理由：唯一一个"已有数据 + 最小行为变化 + 零隐私风险 + 零 schema 变更 +
高可测性"的组合；且它正好补上 §4 认定的核心缺口（关系**不影响说话方式**）。
B 的价值更高但**当前输入不可达**，应先作为独立决策（"trust 是否可以下降"）讨论；
C 属于调参，不作为 Phase 4 内容。

## 6. 非目标（本轮明确不做）

数值→标签映射（恋爱/朋友/敌人）、新增关系维度、读对方 private Memory、从 persona 推断初始
trust、从用户-角色关系推断角色间关系、改关系数值算法、调 S1/M3 阈值、开 M3 enforcement、
扩 autonomous scheduler、decay、jealousy / romance / conflict simulation、大型 social graph、
DB migration。以上全部**需单独决策**。

## 7. 本轮验证

- 只跑 targeted tests，**real AI calls = 0**：
  `tests/test_role_dm.js` **354 绿 / 0 红**、`tests/test_role_dm_social.js` **216 绿 / 0 红**。
- **0 行 production 改动**，审计结论全部来自上述代码位置（`file:line`）。
