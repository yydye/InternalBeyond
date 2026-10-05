# P21-R4-PROD-1 · Cognitive Runtime Control Plane（产品化契约）

> 定位：这是 **R4 主认知闭环完成之后**的产品化契约，**不是**新的认知层。
> 它不改变 Recall / Interpretation / Expectation / BehaviorEffect 的任何语义，
> 只把"操作者改文件"升级为"用户按角色显式控制"，并且**不**给浏览器任何权威。

---

## 1 · 产品链（唯一的权威路径）

```
用户意图
  → Browser/UI intent            （只提交 characterId + 两个布尔意图）
  → authorized narrow boundary   POST /internal/runtime/cognitive-policy
  → 产品级 state matrix          （非法组合在这里被**拒绝**）
  → runtime-policy.js#setCognitive（**唯一** durable writer：一次原子替换）
  → <dataDir>/runtime-policy.json
  → cognitive runtime            （Interpretation / Expectation / BehaviorEffect）
```

冻结值：

```
COGNITIVE_CONTROL_PLANE_READY        = YES
CONTROL_PLANE_BACKEND_READY          = YES
COGNITIVE_POLICY_AUTHORITY           = SERVER_OWNED_FILE_POLICY
COGNITIVE_POLICY_MUTATION_AUTHORITY  = HOME_NODE_AUTHENTICATED_INTERNAL_ROUTE
COGNITIVE_POLICY_SCOPE               = PER_CHARACTER_WITH_GLOBAL_DEFAULT
DEFAULT_AUTO_INTERPRETATION          = OFF
DEFAULT_AUTO_EXPECTATION             = OFF
BROWSER_DIRECT_POLICY_AUTHORITY      = NO
BEHAVIOR_EFFECT_INDEPENDENT_POLICY   = NONE
MAX_COGNITIVE_EXTRA_MODEL_CALLS_PER_CHARACTER_TURN = 2
UI_READY                             = YES
COGNITIVE_UI_PLACEMENT               = CHARACTER_API_SETTINGS_ADVANCED_COGNITIVE_SECTION
COGNITIVE_UI_MUTATION_MODE           = SERVER_CONFIRMED_NON_OPTIMISTIC
EXPECTATION_DEPENDENCY_UI            = DISABLED_UNTIL_INTERPRETATION_ENABLED
BEHAVIOR_EFFECT_UI                   = AUTO_NO_TOGGLE
COST_DISCLOSURE                      = MAXIMUM_CALLS_NOT_GUARANTEED_CALLS
CREDENTIAL_REQUIRED_FOR_POLICY_MUTATION = NO
POLICY_MUTATION_TOUCHES_CREDENTIAL_STORE = NO
POLICY_SURVIVES_CREDENTIAL_UNAVAILABLE_RUNTIME = YES
CREDENTIAL_UNAVAILABLE_AUTO_DISABLES_POLICY = NO
REAL_PROVIDER_CALLS                  = 0
R4_CORE_BEHAVIOR_CHANGED             = NO
PREDICTION_ERROR_LIVE                = NO
COUNTERFACTUAL_AUTO                  = NO
```

## 2 · 变更边界与读契约

**唯一**变更面（窄 route，POST）：

```
{ operation:'read', characterId }
{ operation:'set',  characterId, autoInterpretationEnabled, autoExpectationEnabled }
```

* 请求是**闭集**：额外键（`enabled` / `autoBehaviorEffectEnabled` /
  `memoryInterpretationEnabled` / `provider` / `credentialRef` / `dataDir` /
  `version` / …）一律 `400 request-field-forbidden`。**Browser intent ≠ authority。**
* 响应是**窄投影**：只有 `characterId` · 两个布尔 · `source` · `reasonCode` ·
  `readable` · 权威自述 · 成本上界。**没有** file / dataDir / 其它角色 / 凭据 /
  provider / model / endpoint。
* 落点：`/internal/` 前缀 ⇒ 自动继承 `isDesktopOnlyPath`
  （远端未配置桌面 token → `403 remote-admin-disabled`；配了而没带/带错 →
  `401 unauthenticated`），且不在 `/mobile/` 下 ⇒ 设备面拿不到这条路径。
  非 POST → `405`（`allowedMethods: ['POST']`）。

## 3 · 冻结状态矩阵

| Interpretation | Expectation | 结果 |
| --- | --- | --- |
| OFF | OFF | 合法（默认） |
| ON | OFF | 合法（只有 L3） |
| ON | ON | 合法（L3 + L5 + BehaviorEffect） |
| **OFF** | **ON** | **非法 ⇒ 400 `illegal-cognitive-state`** |

拒绝发生在**权威层**（`runtime-cognitive-policy` + `runtime-policy#setCognitive`
双层），UI 的联动只是体验。非法请求**不产生任何副作用**（不落盘、不建 entry）。

## 4 · 默认 / opt-in / 读无副作用

* 文件缺失 · 读不动 · JSON 坏 · version 不符 · `characters` 不是对象 ·
  角色值不是布尔 · 角色不在表里 ⇒ **一律 OFF**（`source: DEFAULT_OFF` + 具名原因）。
* 没有任何"升级 / 启动 / 聊天 / 凭据存在 / 余额充足 / 首次召回 / Memory 开启 /
  Middle Brain 开启"会自动写入或打开特性：唯一入口是用户显式 mutation。
* **读无副作用**：读不创建 policy 文件、不写角色 entry、不迁移。UI 第一次打开
  不会落盘。

## 5 · 原子性 / 并发 / 坏文件

* 写 = `tmp + fsync + rename + 0600`（沿用既有纪律），**两段一次写**：
  一次用户操作只产生一次原子替换，因此可观测状态只有"旧的一对"或"新的一对"。
* 并发：writer 的 read-modify-write **全程同步**（没有 `await` 缝隙）⇒ 单进程内
  天然串行。实测：两个角色近同时 mutation、以及 12 次快速写之后，
  **两个角色都保留**（0 lost update），文件始终是合法 JSON（没有半份）。
  *诚实边界*：这是**单进程内**的串行性；跨进程并发写同一份文件不在本相位承诺内。
* 坏文件：读 fail closed；写 **409 `policy-file-unusable`**；
  **绝不**静默覆盖坏文件（字节逐字不变），与 desktop-credential 的
  "坏掉的凭据文件绝不重新生成"同一条纪律。

## 6 · 与其它权威的分离

* **Economy**：余额 ≠ 特性 opt-in。本相位不接 Economy，也不新增计费。
* **Credential（P21-R4-PROD-1.1a 冻结口径）**：控制面**不探测 credential
  availability**。policy mutation 与 credential availability **解耦**：角色没有可用
  模型凭据时，`set ON/OFF` / `set ON/ON` 依旧 **200 + 持久化**，readback 就是刚写入的
  值，UI 走 **saved** 分支（**不得**显示"未保存"）；`CREDENTIAL_REQUIRED_FOR_POLICY_MUTATION = NO`。
  policy ON 时若**运行期**凭据不可用，认知调用（Interpretation / Expectation）按**既有**
  `credential-unavailable` / `spec-incomplete` fail semantics 不可用（0 次 provider 调用），
  但**已保存 policy 保持 ON**：不自动关闭、不改回 OFF、不删除角色 entry、不把 mutation
  变成 409/400。凭据存在 ≠ enabled，两者都不构成对方的判据。
  （机器证明：`tests/test_r4_product_cognitive_policy_credential_separation.js`。）
* **外部解释路由**：控制面打开的是 **auto** 解释（文件策略
  `autoInterpretationEnabled`）；外部 caller-proposed `selectedMemoryIds` 路由的
  成本权威是**另一个装配选项**（`costPolicy`，生产不传）⇒
  `EXTERNAL_INTERPRETATION_ROUTE_PRODUCTION_ENABLED = NO` 不变。
* **BehaviorEffect**：**没有**第三个开关、没有独立付费位；它由
  `Interpretation ON AND Expectation ON AND validated L3/L5` 自然生效（+0 次调用）。

## 7 · 成本透明（UI 文案口径）

```
自动解释     最多 +1 次模型调用 / 角色回合
预测与行为   最多再 +1 次
行为影响     自动 · 确定性 · 不调用模型（+0）
整链         最多 +2
```

措辞必须是"**最多**"：zero-memory · 通道不合格 · L3 失败 · L5 失败 · 重放 ·
凭据不可用都会把它降回 0。**不得**显示"每回合一定调用 2 次"。

## 8 · UI（已闭合 · P21-R4-PROD-1.1）

落点：角色 **API 设置 → 「高级认知」** 区块（`#page-api` 内，紧邻「记忆系统设置」）。

```
MINIMAL_REQUIRED_DIRTY_OWNER_PATHS = [
  InternalBeyond.html      REQUIRED = YES  （一条 script include；页面用自己的加载清单加载模块）
]
REQUIRED = NO（不得因为已授权而修改）：
  assets/js/communication.js   记忆设置与本控制面无关；模块自挂载，不需要它的 seam
  assets/js/social.js          loadApiSettingsUI 已是 window 全局 ⇒ 模块在其**外层**包装刷新 hook
  assets/js/core.js            不涉及路由 / 页面外壳
```

* **模块**：`assets/js/cognitive-runtime-settings.js` —— read / render / toggle bind /
  确认 / mutation intent / generation guard / error·status 展示，全部在这一份里；
  dirty 文件只有那**一条** script include（0 行逻辑）。
* **挂载**：模块自挂载到 `#page-api`（只追加自己的一个 `api-section`），HTML 不做 mount markup。
* **客户端**：复用既有已认证客户端 —— 新增窄动词
  `IB.homeNode.runtime.runCognitivePolicy`（`assets/js/home-node-client.js` 的
  `_request` + `assets/js/home-node-bootstrap.js` 的 runtime 面）。UI **不持有 token**、
  不拼请求、不读 Vault、不写 localStorage / IndexedDB。
* **非乐观**：toggle 点击 → `saving` → 只以**服务端返回**（以及链尾 readback）为准；
  失败 ⇒ 回到上一权威状态并明说"未保存"。
* **依赖**：I=OFF 时 E 的 toggle `disabled` + 文案"需要先开启自动解释"（不偷偷联动开启 I）；
  关 I 而 E 在开 ⇒ 一次依赖确认 + **一次**原子写 `I=false,E=false`。
* **确认**：仅 OFF→ON 各一次（成本文案含"最多"）；关闭永不二次确认；
  不新增任何持久化 consent 状态。
* **成本**：`自动解释 最多 +1` / `预测与行为 最多再 +1` / `完整认知模式 最多 +2` /
  `行为影响 自动 · 确定性 · 不调用模型（+0）`。
* **视觉**：只消费既有语义 token 与既有组件类（`api-section api-paper` /
  `api-form-group` / `form-check-row` / `u-native-check` / `field-hint` /
  `settings-description`）—— 零新增 CSS、零内联样式、零渐变/毛玻璃/紫蓝 SaaS 感，
  Internal / Infernal 两主题同源。
* **可访问性**：真 `checkbox` + `label[for]` + `disabled` + `role="status"` /
  `aria-live="polite"`；状态与错误都有**文本**（不靠颜色）；390px 无横向溢出。

（`REQUIRED_DIRTY_OWNER_PATHS` 已在 PROD-1.1 获得窄授权；用户 hunk 逐字节保留：
逆应用 PROD1_UI hunk 后 sha256 与授权前逐字节相等 ⇒ `ILLEGAL_USER_HUNK_MUTATIONS = 0`。）

## 9 · 本相位**没有**做

Prediction Error · Counterfactual 自动调用 · canonical memory /
relationship / persona / speech_style / tool policy 的任何修改 ·
Recall / Interpretation / Expectation / BehaviorEffect 的语义修改 ·
Economy 计费。

## 10 · 相位闭合（P21-R4-PROD-1.2）

**16 条精确路径**（candidate = `HEAD + 这 16 条`；dirty-owner 文件用 `HEAD blob + 仅授权
hunk`，**从不**用整个 dirty worktree）：

| 类别 | 路径 |
|---|---|
| BACKEND（权威） | `services/home-node/runtime-policy.js` · `services/home-node/runtime-cognitive-policy.js` · `services/home-node/http.js` · `services/home-node-service.js` |
| CLIENT | `assets/js/home-node-client.js` · `assets/js/home-node-bootstrap.js` |
| UI | `InternalBeyond.html`（**1** 个授权 hunk）· `assets/js/cognitive-runtime-settings.js` |
| REGISTRY | `tests/test-all.js` |
| TESTS | `tests/test_r4_product_cognitive_policy.js` · `tests/test_r4_product_cognitive_policy_browser.js` · `tests/test_r4_product_cognitive_policy_credential_separation.js` |
| GUARDS | `tests/test_r4f_live_behavior_effect.js` · `tests/test_r4c_live_runtime_boundary.js` |
| FIXTURE/PIN | `tests/fixtures/memory-recall-contract/production-hashes.json` |
| DOCS | `docs/P21-R4-PROD-1-COGNITIVE-CONTROL-PLANE.md` |

* R4 核心运行时 byte-identical：`runtime-recall.js` · `runtime-interpretation.js` ·
  `runtime-expectation.js` · `runtime-behavior-effect.js` · `behavior-effect-render.js`
  ⇒ `R4_CORE_BEHAVIOR_CHANGED = NO`。
* 两条守卫是**带注释的相位迁移**（运行面动词闭集 3→4；R2-A 对
  `home-node-bootstrap.js` 的 canonical pin 重钉），不是放宽。
* 用户 hunk 逐字节保留：`USER_HUNKS_BYTE_PRESERVED = YES` ·
  `ILLEGAL_USER_HUNK_MUTATIONS = 0` · BOM/CrLf 保留 ·
  `communication.js` / `social.js` / `core.js` / `memory.js` 未被 stage。

（UI 已在 P21-R4-PROD-1.1 闭合：`UI_READY = YES`，见 §8。）
