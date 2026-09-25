# Credential Authority Convergence R7 Capability Integration

日期：2026-09-22（Asia/Shanghai）

R0：complete  
R1：complete  
R2：PASS  
R3：complete  
R4：PASS  
R5：PASS  
R6：PASS  
R7：PASS

R7 将 Middle Brain、Image Router 和 Voice capability consumer 接入 R6 的 secret-free authority projection 语义，但不执行 credential migration，不删除 legacy key，不改变 provider execution，不改变 Bridge/Home Node ownership。

新增 capability consumer seam：

assets/js/credential-authority-consumers.js

新增 Middle Brain owner-side wrapper：

assets/js/middle-brain-config.js

新增 Image Router/Voice status consumer：

assets/js/credential-authority-consumers.js

## A. Scope

R7 完成：

- Middle Brain 的 status-only Hybrid integration。
- Image Router 的 apiConfigId → credentialStatus wrapper integration。
- Voice/TTS/ASR/Voicebox/Edge/voiceTrans ownership audit 和 status classification。
- 复用 R6 IB.host credential_status seam。
- 真实绑定 metadata/status 的只读统计。
- Active execution、Image execution、Middle Brain execution 和 Bridge ownership regression。

R7 不做：

- credential migration。
- Vault schema rewrite。
- persisted v2 credentialRef migration。
- 删除 apiKey。
- provider validation。
- Middle Brain provider execution cutover。
- Image Router provider execution cutover。
- voiceTrans cutover。
- Bridge/Home Node ownership change。
- Backup v2、Storage Convergence、P33、Android 或 Jev。

## B. Existing Credential Boundaries

### B1. Desktop Local Authority

R6 已建立：

Web Core  
→ IB.host credential_status  
→ Tauri command  
→ R5 read-only adapter  
→ credentialVault.has()

R7 复用该 seam，不创建第二套 Desktop Credential Authority。

### B2. Middle Brain

当前 owner：

- apiSettings['middle_brain']。
- policy、model、reasoning、image mode 和 integrity configuration 属于 Middle Brain config layer。
- 当前 legacy credential field 仍可能存在于 config，但 R7 status wrapper 不读取它来判断 status。

### B3. Image Router

当前 owner：

- apiSettings['image_router'].routes。
- route.apiConfigId → apiConfigs。
- 既有 resolveRoute() 仍保留 execution compatibility path。

R7 新增的 authority consumer 只查询 credentialStatus，不改变 resolveRoute/provider execution。

### B4. Voice

| Voice path | Owner | R7 decision |
|---|---|---|
| Edge TTS | local/browser capability | KEEP_SEPARATE / none |
| Voicebox | Bridge local runtime | KEEP_SEPARATE / none |
| OpenAI-compatible TTS | Bridge config tts | KEEP_SEPARATE / bridge-owned |
| MiMo TTS | Bridge config ttsMimo | KEEP_SEPARATE / bridge-owned |
| ASR | Bridge config voiceAsr | KEEP_SEPARATE / bridge-owned |
| browser voiceTrans | apiSettings voiceTrans legacy | KEEP_SEPARATE；未来独立 cutover seam |
| Role voice profile | role metadata source/profile | WRAPPER_ONLY；不拥有 secret |

## C. Middle Brain Audit

代码证据：

- assets/js/middle-brain-config.js:5,66,102-120 定义 apiSettings['middle_brain'] authority。
- assets/js/middle-brain-config.js:118-120 使用独立 endpoint/model/apiKey readiness semantics。
- assets/js/middle-brain-astra.js:127-150,221-259 维持现有 Astra execution path。
- services/home-node/middle-brain.js:25-30,296-318 不让 Home Node 持有 Middle Brain credential。

R7 integration：

- middle-brain-config.js 增加 owner-side getMiddleBrainCredentialStatus()。
- 该函数只读取 enabled 和 credentialRef metadata。
- 没有 credentialRef 时返回 unknown/CREDENTIAL_REF_MISSING。
- 不读取 apiKey 作为 status authority。
- disabled policy 返回 none/middle-brain-policy-disabled。
- 有 credentialRef 时通过通用 queryBinding 复用 R6 IB.host seam。
- 不加入 MB_PUBLIC_API，不改变 existing Middle Brain facade order，不改变 prompt/Astra/admission/integrity semantics。

因此：

Middle Brain policy/config  
≠  
Credential storage/status authority

真实当前 profile metadata-only audit 没有发现 middle_brain record；R7 不将其解释为 credential lost。当前 legacy config 的实际 authority 仍是独立 config boundary，credentialRef migration 留给后续阶段。

## D. Image Router Audit

代码证据：

- assets/js/image-router-config.js:1-18 定义 route.apiConfigId 的绑定语义。
- assets/js/image-router-config.js:60-100 以 apiSettings['image_router'] 存储 route metadata。
- assets/js/image-router-config.js:112-118 通过 findApiConfig() 解析绑定。
- assets/js/image-router-config.js:136-137 现有 execution path 仍可能读取 imageGenApiKey/apiKey。
- assets/js/image-router-config.js:166-274 的 resolveRoute() 负责 endpoint/model/provider/capability 和 execution config。

R7 integration：

- 通用 capability consumer 增加 imageRouteStatus(routeName)。
- route.apiConfigId 存在时，仅通过 R6 credentialStatus seam 查询 image.generate status。
- route 没有 apiConfigId 时返回 unknown/image-router-inherit-binding，不猜测角色 key。
- Image Router 不成为 secret store。
- resolveRoute()、provider adapter、图片请求、fallback execution 均未修改。

真实当前 profile metadata-only audit：

- apiConfigs records：0。
- image_router route record：未发现。
- route credential references：0。

该结果只代表当前隔离 profile 的 metadata 状态，不代表历史 Image credential 丢失。

## E. Voice Boundary Audit

Bridge code evidence：

- bridge/tts.js:10-13 明确角色只保存 source/profile，endpoint/apiKey 由 Bridge config 提供。
- bridge/tts.js:307-371 使用 tts/ttsMimo 独立 credential sections。
- bridge/routes.js:107-110 对 proactive、tts、ttsMimo、voiceAsr 做 secret mask。
- bridge/routes.js:741-749 的 TTS source projection 只返回来源说明、能力和 configured status，不返回 endpoint/apiKey。
- bridge/voicebox.js:61 将 Voicebox 定义为本地 runtime，默认不需要 API key。
- assets/js/communication/voice.js:35-80 的 voiceTrans 是独立 browser apiSettings path。

R7 voiceStatus 语义：

- edge、voicebox、local-runtime → none。
- tts、ttsmimo、voiceasr、voicetrans → unknown + bridge-owned/legacy source classification。
- 不把 Bridge credential 合并到 Desktop Local Authority。
- 不把 voice profile 的 source/profile 解释成 secret reference。

真实 Bridge metadata baseline：

- tts、ttsMimo、voiceAsr、proactive provider apiKey presence：未发现当前配置值存在。
- voicebox：local runtime boundary。
- music/external integration secret：仍归 Bridge-owned，不纳入 Desktop provider status。

R7 没有读取或输出任何 Bridge secret，也没有修改 Bridge config。

## F. Chosen Authority Ownership

| Consumer | Status owner | Secret owner | R7 result |
|---|---|---|---|
| Chat/Active Message | Desktop Local Authority | Desktop Local Vault | R6 seam reused |
| Middle Brain | Desktop Local projection when credentialRef exists；legacy otherwise unknown | Current legacy config until future migration | Hybrid, policy separate |
| Image Router | Desktop Local projection through apiConfigId | API Config/Local Authority future boundary | Wrapper-only |
| TTS | Bridge Authority | Bridge config tts/ttsMimo | KEEP_SEPARATE |
| ASR | Bridge Authority | Bridge config voiceAsr | KEEP_SEPARATE |
| Voicebox | Local Runtime | none by default | KEEP_SEPARATE |
| Edge voice | local/browser capability | none | KEEP_SEPARATE |
| voiceTrans | legacy browser capability | apiSettings voiceTrans today | KEEP_SEPARATE, future cutover |
| Home Node | Home Node Device Authority | Home Node credential | unchanged |

Middle Brain、Image Router 不直接访问 Vault。Bridge 不变成 Desktop Credential Authority。

## G. Projection Integration

通用 consumer module：

assets/js/credential-authority-consumers.js

提供：

- queryBinding(binding)
- imageRouteStatus(routeName)
- voiceStatus(profile)

Middle Brain owner-side wrapper：

- middleBrainStatus() 注册在 IB.credentialAuthorityConsumers。
- 不扩展 MB_PUBLIC_API。
- 不读取 apiKey。
- 不改变 middleBrainReady() 或 Astra execution。

统一 status：

- ready
- missing
- unavailable
- unknown
- none

R7 保持 ready 的严格含义：

Local Authority 可以解析 credential presence。

ready 不表示 provider valid、网络可达、model 存在或 quota 足够。

## H. Security Boundary

R7 复用 R6 IB.host credential_status：

- 不创建第二套 credential endpoint。
- 不创建 Middle Brain 私有 Vault endpoint。
- 不创建 Image Router 私有 Vault endpoint。
- 不让 Bridge/Home Node 接管 Desktop Vault。
- projection 只含 credentialRef/status/presence/source/error。
- 不含 apiKey、Authorization、Bearer、fingerprint、ciphertext 或 Vault content。

consumer module 只接受 status projection。它不会把 stored legacy config spread 到 projection，也不会将 execution cfg 回注入 secret。

## I. Real Binding Audit

R6 real status baseline 继续成立：

| Binding category | Count | Status |
|---|---:|---|
| Active live role refs | 22 | observed |
| Credential-required bindings | 21 | observed |
| Ready | 21 | ready |
| Missing required | 0 | none |
| char_bgai | 1 | none |

R7 current WebView profile metadata-only audit：

| Domain | References observed | Resolved | Missing | Owner |
|---|---:|---:|---:|---|
| Middle Brain apiSettings target record | 0 | 0 | 0 | legacy Middle Brain config boundary |
| Image Router route refs | 0 | 0 | 0 | route wrapper / Desktop projection future |
| browser voiceTrans target record | 0 | 0 | 0 | legacy browser audio boundary |
| Active credential-required live bindings | 21 | 21 | 0 | Desktop Local Authority |
| char_bgai | 1 | none | not applicable | local/test fixture |

WebView audit使用隔离 profile copy，只输出 store counts、field presence 和 route/ref counts；没有输出记录值。

## J. Regression

API Config R6：

- credentialStatus cutover remains in renderApiList：PASS。
- cfg.apiKey status fallback absent：PASS。
- Browser remote fallback remains unavailable, not key fallback：PASS。

Active Message：

- R5 read-only adapter regression：PASS。
- 21/21 ready baseline：PASS。
- execution path unchanged：PASS。

Middle Brain：

- policy/config runtime path unchanged：PASS。
- Astra/Admission/Integrity execution unchanged：PASS。
- legacy no-ref status is unknown, not inferred from apiKey：PASS。

Image Router：

- resolveRoute/provider execution unchanged：PASS。
- imageRouteStatus wrapper is projection-only：PASS。

Voice：

- Bridge ownership unchanged：PASS。
- Voicebox/Edge no-credential semantics unchanged：PASS。
- voiceTrans remains separate legacy boundary：PASS。

Provider calls：0。

仓库全量 frontend structure suite 仍报告 7 个既有 BOM 缺失项，涉及 economy/autonomy/communication/home-node 文件；这些 failure 在 R7 前已存在，R7 新增 consumer 已补齐 BOM，没有增加新的结构 failure。R7 专项 capability、R5/R6 回归和结构语义守卫均通过。

## K. Production Invariance

R7 没有执行任何 production credential/data write：

- credential-vault.json：unchanged。
- credential-vault.key：unchanged。
- apiConfigs_recovery_import.json：unchanged。
- active-message-service.json：unchanged。
- Bridge config：unchanged。
- Home Node credential：unchanged。
- IndexedDB/localStorage：没有 credential migration。
- Middle Brain apiSettings：没有写入 credentialRef。
- Image Router apiSettings：没有写入 credentialRef。
- Voice/Bridge config：没有修改。

R7 新增的是 capability wrapper、test、script load 和报告，不是 secret migration。

## L. R8 Entry Gate

R7 evidence gate：

1. Middle Brain status boundary explicit：PASS。
2. Image Router wrapper-only status boundary：PASS。
3. Voice ownership explicit：PASS。
4. R6 status transport reused：PASS。
5. No plaintext secret crosses projection：PASS。
6. Active execution unchanged：PASS。
7. Image execution unchanged：PASS。
8. Bridge/Home Node ownership unchanged：PASS。
9. Real Active baseline 21 ready/0 missing：PASS。
10. Provider calls：0。
11. Production data unchanged：PASS。

R8 authorization gate 仍关闭。R8 只能在明确批准后开始下一阶段。

## Closure Gate

**Credential Authority Convergence R7 complete.**

**Credential consumers now use the Desktop Local Authority projection without exposing secrets.**

**Middle Brain, Image Router and Voice boundaries remain explicit.**

**Existing execution paths remain unchanged.**

**Provider calls: 0.**

R7 只完成 capability/status integration；没有 credential migration、Vault rewrite、legacy deletion 或 ownership change。

R8 may begin only after explicit approval.
