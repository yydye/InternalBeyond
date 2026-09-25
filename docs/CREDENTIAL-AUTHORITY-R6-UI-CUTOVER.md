# Credential Authority R6 API Config / UI Cutover

日期：2026-09-22（Asia/Shanghai）

R0：forensic complete  
R1：authority mapping complete  
R2：PASS  
R3：Credential Authority v2 design complete  
R4：PASS / synthetic validation  
R5：PASS / real Vault read-only adapter  
R6：PASS

R6 完成了 production API list 的 credential status authority cutover：

旧路径：

Role/API Config  
→ page-readable cfg.apiKey  
→ “有密钥/无密钥”

新路径：

Web Core  
→ IB.host credential_status capability  
→ Tauri Host command  
→ bundled Node R5 read-only adapter  
→ credentialVault.has()  
→ secret-free credentialStatus projection

本阶段没有迁移 credential data，没有删除 legacy apiKey，没有写 Vault，没有接 provider。

## A. Scope

R6 完成：

- 建立安全的 Web Core → Desktop Local Authority status seam。
- 将 API Config 列表的 status authority 从 cfg.apiKey 切换到 credentialStatus。
- 保留 legacy API editor 的读取/写入兼容路径，但不再用它决定列表状态。
- 对真实 Vault 的 21 个 credential-required live bindings 进行 ready projection。
- 保持 char_bgai 为 none / NO_CREDENTIAL_REQUIRED。
- 保持 Active provider execution path 不变。
- 为 Browser fallback 明确 unavailable，不回退 cfg.apiKey。

R6 不做：

- credential data migration。
- Vault rewrite、upsert、restore、import、recovery cleanup。
- persisted v2 credentialRef migration。
- Middle Brain、Image Router、voiceTrans credential cutover。
- Backup v2、Storage Convergence、P33、Android、Jev。

## B. Pre-flight

- Branch：master，ahead 147。
- HEAD：e2d6e886fb1a1e27c5882236719f65c8dfd8e8e6。
- 工作区已有大量 tracked modifications 和 untracked files；全部保留。
- 没有执行 reset、clean、restore、checkout、stash、commit 或 push。
- R0、R1、R2、R3、R4、R5 作为 immutable baseline 读取。

R6 新增/修改范围：

- assets/js/host-capability.js：新增 credential-status host capability。
- assets/js/social.js：API list status projection cutover；不改变 legacy editor。
- active/credential-authority-adapter-cli.js：Tauri Host 到 R5 adapter 的 bounded bridge。
- src-tauri/src/lib.rs：新增 allowlisted credential_status command。
- tests/test_credential_authority_r6_ui_cutover.js：R6 contract/acceptance test。
- docs/CREDENTIAL-AUTHORITY-R6-UI-CUTOVER.md：本报告。

## C. Current UI Authority

当前旧 UI 证据：

- assets/js/social.js:845-854 的 renderApiList() 生成角色 API 列表。
- assets/js/social.js:851 原先直接通过 a.apiKey 判断“无密钥”。
- assets/js/social.js:808-841 从 IndexedDB apiConfigs 与 fallback mirror 加载配置。
- assets/js/social.js:832-838 还保留旧 apiSettings.main → apiConfigs 的兼容迁移路径。
- assets/js/social.js:1147 将 cfg.apiKey 填入编辑器 input。
- assets/js/social.js:1297 在 saveCurrentApi() 中读取并写入 apiKey。

R6 后：

- renderApiList() 不再通过 cfg.apiKey 或 a.apiKey 判断列表状态。
- 列表使用 _ibLoadApiCredentialProjection()。
- 投影字段包括 credentialRef、authorityScope、credentialStatus、credentialSecretPresent、sourceClass、errorCode。
- 投影对象不包含 apiKey、imageGenApiKey、Authorization、Bearer、secret 或 fingerprint。
- legacy editor 仍然存在，但它不再是 status authority。

## D. Transport Candidate Audit

| Candidate | Browser works? | Tauri works? | Authenticated? | Secret-free? | Adds authority? | Existing contract? | Risk |
|---|---|---|---|---|---|---|---|
| Active HTTP direct status endpoint | yes | yes | loopback/origin only；无专用 token | 可做到 | 否 | 只有 POST /credentials | 会扩大 presence oracle，尤其 Origin null |
| Bridge channel | yes | yes | Bridge token | 可做到 | 是错误 authority | Bridge-owned | 不应成为 Desktop Credential Authority |
| Home Node channel | yes | yes | desktop credential | 可做到 | 是错误 authority | 已有 authenticated internal channel | 不应拥有 provider Vault |
| Browser direct cfg.apiKey fallback | yes | yes | no | 否 | 会绕过 authority | legacy only | R6 明确禁止 |
| IB.host Tauri command | Tauri canonical | yes | Tauri WebView command allowlist | 是 | 否，调用既有 adapter | P32 IB.host seam | 需要 command payload bounds |
| Browser IB.host fallback | yes | no native command | unavailable response only | 是 | 否 | host capability contract | remote status becomes unavailable |

选择：Tauri IB.host credential_status command。  
Browser fallback：不查询 Active HTTP，不回退 cfg.apiKey，remote binding 返回 unavailable；loopback/local binding 可返回 none。

## E. Chosen Status Transport

canonical transport：

Web Core  
→ IB.host.credentialStatus.query()  
→ Tauri command credential_status  
→ active/credential-authority-adapter-cli.js  
→ active/credential-authority-adapter.js  
→ credentialVault.has()

实现要点：

- Tauri command 使用 bundled Node runtime。
- Node CLI 调用既有 R5 adapter，不复制 Vault 解密逻辑。
- CLI 只允许当前 Active metadata 中已知的 binding IDs。
- 未知 binding 返回 unknown / BINDING_NOT_CURRENT，不调用 Vault has()。
- batch 上限为 200。
- output schema 被 Rust Host 再次校验，只允许 projection property names。
- 没有 HTTP status endpoint，没有新的 network authority。

## F. Authentication Boundary

R6 的 canonical caller 是 Tauri WebView 通过 IB.host 调用 allowlisted Tauri command。

caller boundary：

- WebView 必须处于 Tauri host surface。
- command 必须注册在 src-tauri/src/lib.rs 的 invoke_handler allowlist。
- command 不监听网络端口。
- command 不接受任意 shell/path/Node script 参数。
- bindingId 只能使用 bounded、validated ID 字符集。
- request batch 最大 200。
- Rust Host 对 child projection schema 做 allowlist 校验。
- Node CLI 对当前 Active metadata binding set 做二次校验。

Tauri command 不把 Home Node token、Bridge token 或 Vault key 交给 WebView。

## G. Enumeration Protection

R6 不允许 arbitrary Vault presence enumeration：

- request 数量上限为 200。
- bindingId 需要满足长度和字符集限制。
- CLI 只对当前 Active metadata 已知的 binding 调用 adapter。
- 未知 ID 返回 unknown/BINDING_NOT_CURRENT，不区分 Vault 中是否存在该 ID。
- batch response 不返回 provider、model、endpoint、fingerprint 或 Vault metadata。
- 不提供“列出所有 Vault bindings”的命令。

这不是完整的用户身份认证；它是 Tauri trusted WebView capability boundary。Browser/HTTP 不获得同一查询面。

## H. API Config Projection

R6 的 runtime projection 由 assets/js/social.js 的以下 helper 组成：

- _ibApiCredentialEndpointClass()
- _ibApiCredentialLocalStatus()
- _ibApiCredentialBindings()
- _ibLoadApiCredentialProjection()
- _ibApiCredentialProjection()
- _ibRenderApiList()

Projected API Config 只在 runtime projection map 中存在，不写回 IndexedDB：

| Field | Projection |
|---|---|
| id/provider/model/endpoint metadata | retained as non-secret UI metadata |
| credentialRef | opaque compatibility reference |
| authorityScope | desktop-local |
| credentialStatus | ready/missing/unavailable/unknown/none |
| credentialSecretPresent | boolean |
| sourceClass | authority source class |
| errorCode | stable redacted code |
| apiKey | omitted |
| imageGenApiKey | omitted |
| Authorization/Bearer | omitted |

Stored legacy apiKey 仍可存在；storage compatibility 与 frontend projection 已分离。

## I. Legacy Editor Compatibility

R6 保留：

- editApi() 的 legacy credential edit path。
- saveCurrentApi() 的 legacy apiKey write path。
- cfg.apiKey 的 stored compatibility field。

R6 不做：

- 不把 Vault secret 回填 editor。
- 不把 credentialRef 自动写入 production records。
- 不清空或删除 cfg.apiKey。
- 不迁移 apiConfigs。

列表页和编辑页边界：

- 列表页只消费 credentialStatus projection。
- 编辑页仍是明确的 LEGACY CREDENTIAL EDIT PATH。
- Authority projection 不会把 Vault secret 注入 cfg 或 DOM。

## J. renderApiList Cutover

renderApiList() 现在的状态流程：

1. loadApiConfigs() 读取既有 stored config metadata。
2. 先以 checking 或 loopback none 渲染中性状态。
3. 调用 IB.host.credentialStatus.query()。
4. 用 projection.status 重绘 status tag。
5. Tauri unavailable 时，remote binding 显示 unavailable；不使用 cfg.apiKey fallback。

文案：

| Status | UI text |
|---|---|
| ready | 凭据就绪 |
| missing | 缺少凭据 |
| unavailable | 凭据服务不可用 |
| unknown | 凭据状态未知 |
| none | 无需凭据 |
| checking | 正在检查凭据状态 |

ready 只表示本地 authority presence ready，不表示 provider key valid、网络正常或 quota 足够。

## K. Loading / Failure Semantics

初始渲染：

- remote binding：checking。
- loopback/local binding：none。
- 不再先显示红色“无密钥”再闪成 ready。

Authority failure：

- Tauri command unavailable：remote → unavailable。
- Browser fallback：remote → unavailable。
- loopback/local：none。
- 不回退到 cfg.apiKey presence。

只有 authority 明确返回 binding missing 时，才显示 missing。

## L. Browser Fallback

Browser host capability：

- IB.host.credentialStatus.available=false。
- query() 返回 credential-status-unavailable。
- social.js 不访问 Active HTTP、不访问 cfg.apiKey 作为 fallback。
- remote API Config status 为 unavailable。
- loopback/local status 为 none。

Browser fallback 仍可继续使用页面其他功能，但 API status path 是 DEGRADED；它不会通过不安全 HTTP oracle 换取绿色状态。

Canonical product path 是 Tauri desktop，因此 R6 overall evidence gate 仍为 PASS，并明确记录 Browser fallback DEGRADED。

## M. Tauri Host Integration

新增 Tauri command：

credential_status

位置：src-tauri/src/lib.rs。

Host command：

- 读取 request bindings。
- 校验 batch/ID bounds。
- 启动 bundled Node CLI。
- 将 bounded JSON request 通过 stdin 发送。
- 读取 bounded JSON projection。
- 对 response keys 做 allowlist 校验。
- 不把 stderr、Node stack 或任何 raw credential 返回 WebView。

Web Core 只通过 assets/js/host-capability.js 的 IB.host.credentialStatus.query() 调用：

- social.js 不直接使用 window.__TAURI__。
- social.js 不直接 invoke Rust。
- Tauri-only business logic 不进入 social.js。

Cargo check 已通过。

## N. Real Vault Acceptance

R6 通过 Tauri/CLI-compatible production seam 对真实 Vault 做 read-only status projection：

| Binding class | Count | Result |
|---|---:|---|
| live role refs | 22 | observed |
| credential-required refs | 21 | ready |
| ready | 21 | PASS |
| missing | 0 | PASS |
| unavailable | 0 | PASS |
| char_bgai | 1 | none |

R6 没有调用 provider，ready 只代表 Local Authority 能读取 required binding presence。

## O. Screenshot Acceptance

R6 解决的产品语义：

- real Vault-backed role：Frontend 没有 plaintext apiKey，但 projection ready → “凭据就绪”。
- loopback/local/no-credential：→ “无需凭据”。
- authority unavailable：→ “凭据服务不可用”。
- true missing binding：→ “缺少凭据”。

旧截图中的“无密钥”不再作为 production status authority。旧 stored apiKey 仍可用于 legacy editor，但不会决定列表 status。

## P. Secret Boundary

R6 status response 只允许：

- bindingId。
- credentialRef opaque alias。
- authorityScope。
- status。
- secretPresent boolean。
- sourceClass。
- errorCode。

禁止进入：

- DOM。
- HTTP response。
- Tauri response。
- console。
- error。
- telemetry。
- IndexedDB/localStorage。
- report artifact。

R6 test projection forbidden property count：0。

## Q. Active Runtime Compatibility

R6 没有修改：

- services/active-message-service.js。
- active/model-client.js。
- active execution/provider path。
- scheduler/plans/moments。
- communication.js provider request path。

Active execution 仍然：

credential-vault  
→ existing get()  
→ model-client/provider execution

R6 adapter/CLI 只旁路读取 status，不接管 execution，也不把 credentialRef 回注入 Active runtime。

R5 regression test 继续通过。

## R. Production Invariance

R6 前后未发生 credential/data migration：

- credential-vault.json unchanged。
- credential-vault.key unchanged。
- apiConfigs_recovery_import.json unchanged。
- active-message-service.json unchanged。
- Bridge config unchanged。
- Home Node credential unchanged。

没有：

- Vault upsert。
- Vault rewrite。
- recovery import。
- IndexedDB credential migration。
- localStorage credential migration。
- apiSettings/apiConfigs automatic rewrite。
- legacy apiKey deletion。

## S. Tests

### S1. Authority transport

- Tauri host command capability accepted：PASS。
- Browser fallback returns unavailable：PASS。
- malformed/oversized request bounded：PASS。
- unknown binding does not query Vault：PASS。
- response projection secret-free：PASS。

### S2. Projection

- 21 real ready bindings：PASS。
- missing semantic available：PASS。
- unavailable semantic available：PASS。
- unknown semantic available：PASS。
- none semantic available：PASS。
- locked/disabled not fabricated：PASS。

### S3. UI

- ready → 凭据就绪：PASS。
- missing → 缺少凭据：PASS。
- unavailable → 凭据服务不可用：PASS。
- unknown → 凭据状态未知：PASS。
- none → 无需凭据：PASS。
- checking → neutral loading：PASS。

### S4. Critical regression

cfg.apiKey absent + credentialStatus ready → ready projection：PASS。

authority unavailable + cfg.apiKey present → unavailable，不回退 ready：PASS。

### S5. Secret boundary

- Frontend projection secret-free：PASS。
- DOM property semantics secret-free：PASS。
- serialized transport secret-free：PASS。
- console/error/telemetry secret-free：PASS。

### S6. Active compatibility

- existing Active execution path unchanged：PASS。
- Cargo check：PASS。
- R5 real read-only adapter regression：PASS。
- Provider/model calls：0。

## T. R7 Entry Gate

R7 evidence gate：

1. Production UI status authority 已从 cfg.apiKey 切走：PASS。
2. Safe local status seam 已建立：PASS，Tauri command capability。
3. Real Vault 21 required bindings 可投影 ready：PASS。
4. Frontend 不需要 secret：PASS。
5. UI 不再显示由 page-readable key presence 驱动的 false “无密钥”：PASS。
6. Authority failure 不 fallback 到 cfg.apiKey：PASS。
7. Browser fallback 不降低安全性：PASS，remote explicit unavailable。
8. Active execution unchanged：PASS。
9. Production credential data unchanged：PASS。
10. Provider calls：0。

R7 authorization gate 仍关闭。R7 只允许在用户明确批准后开始 Middle Brain/Image Router/voiceTrans capability integration。

## U. Remaining

1. Browser fallback 仍是 explicit DEGRADED；如果未来需要 Browser remote status，必须先建立 authenticated local Host/IPC seam。
2. Legacy apiKey storage/editor 仍存在，但已不再是 API list status authority。
3. R7 前不得把 Middle Brain、Image Router 或 voiceTrans 切到 Desktop Local Authority。
4. 不执行 persisted v2 credentialRef migration。
5. 不删除 recovery artifact、emergency mirror 或 legacy apiKey。
6. 不实现 Backup v2、Storage Convergence、P33、Android 或 Jev。

## Closure Gate

R6 PASS 条件全部满足：

- canonical status transport：Tauri IB.host command。
- no unauthenticated Active HTTP credential-status endpoint。
- transport bounded、allowlisted、secret-free。
- real live refs：22。
- credential-required：21。
- ready：21。
- missing：0。
- char_bgai：none。
- DOM/transport/log/error/telemetry secret leak：0。
- provider/model calls：0。
- Active execution unchanged。
- production credential data unchanged。

**Credential Authority Convergence R6 complete.**

**Production API/UI credential status authority has been cut over from page-readable apiKey presence to the secret-free Desktop Local Credential Authority projection.**

**No plaintext credential crosses the frontend boundary.**

**Legacy credential storage/edit paths remain compatibility-only and are not used as status authority.**

**Existing Active execution remains unchanged.**

**Production credential data was not migrated.**

**Provider calls: 0.**

**R7 capability integration may begin only after explicit approval.**
