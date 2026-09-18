# P22-23 · Economy First-Run / Home Node Provisioning Closure

> **verdict: P22 Economy First-Run = CLOSED**
>
> 证据：`tests/test_p22_23_home_node_provisioning.js` 47/47 ·
> `tests/test_p22_23_first_run_acceptance.js` 24/24（真实 Chromium + 真实
> Home Node + 真实静态层，走完「选角色 → 输入初始额度 → 两步确认 → 提交 →
> Wallet READY」）。

---

## 1. 审计：为什么正常启动后 Economy 还在要求用户设环境变量

### 1.1 触发事实（只读探针，未打印任何 secret）

```
serverSideEnv.IB_HOME_NODE_TOKEN  configured:false  length:0
ports.homeNode                    23118 responding:200 ok:true
homeNode.security.economyPolicy.configuration.open   false
writeSurfaceNoCredential          status:503 reasonCode:ECONOMY_CONFIGURATION_DESKTOP_TOKEN_NOT_CONFIGURED
                                  hint:"set IB_HOME_NODE_TOKEN to enable the economy configuration path"
```

Home Node **是活着的**。缺的不是生命周期，是凭据。

### 1.2 凭据 authority 的真实形状（改造前）

| 位置 | 事实 |
| --- | --- |
| `services/home-node-service.js:103` | `const TOKEN = String(process.env.IB_HOME_NODE_TOKEN \|\| '')` —— **唯一**的服务端来源 |
| `assets/js/home-node-client.js:37` | `localStorage['ib_home_node_token']` —— **唯一**的浏览器来源 |
| `services/home-node/economy-configuration.js:266` | `credentialConfigured = desktopCredential.trim() !== ''`；空串 ⇒ 整面 `open:false` ⇒ 503 |
| 全仓 | **没有任何代码**生成、保存或分发过这份凭据 |

于是：

* 「谁应该创建它」—— 没有任何人；产品文档把它写成用户的部署步骤。
* 「谁读它」—— 服务端 env、浏览器 localStorage，**两个互不相干的来源**。
* 「谁传给它」—— 没有人。没有任何代码把凭据交给 Desktop / browser runtime /
  Home Node client / Economy。
* 「它是否只存在于 process.env」—— 是（服务端侧）。

### 1.3 真实启动链（改造前）

```
Start Internal Beyond.cmd
  └─ runtime/launch-internal-beyond.js
       └─ runtime/local-services-runner.js:159-163   homeNode: { env: {} }
            └─ services/home-node-service.js           TOKEN = env['IB_HOME_NODE_TOKEN'] || ''
                 └─ 23118 /health  200（与凭据无关）
                      └─ economy-configuration seam  open:false
                           └─ UI「这里现在还改不了 / 请先设置环境变量」
```

端点由 `runtime/component-registry.js` 唯一决定（`IB_HOME_NODE_PORT`，默认
23118），浏览器侧由 `home-node-client.js` 的 `DEFAULT_BASE = 'http://127.0.0.1:23118'`
同源约定 —— **这两条都没问题**。断裂点只在凭据。

### 1.4 分类（§4）

* **B · MISSING FIRST-RUN PROVISIONING** —— 主线：产品确实要求用户自己设
  环境变量，没有面向普通用户的自动 provisioning。
* **D · AUTHORITY SPLIT** —— 同时成立：服务端（env）与浏览器（localStorage）
  各自维护一份来源，而两者都没有写入方。

不是 A（不存在"已有 canonical provisioning 但没接上"）、不是 C（Home Node
确实在跑）。修复方式因此是"建一条唯一的 provisioning 通道"，而不是"把某处
已经存在的接线接回来"。

---

## 2. 实现

### 2.1 唯一 credential authority

新增 `services/home-node/desktop-credential.js`。它只回答一个问题：
**这台机器的桌面凭据是什么、从哪来、可靠吗。**

优先级固定三种，没有第四种：

| 来源 | 语义 |
| --- | --- |
| `env`（`IB_HOME_NODE_TOKEN`） | 最高优先级。**语义一个字没改** —— developer / headless / 测试的既有旋钮；它同时关闭自动 provisioning（部署方已经决定了凭据） |
| `file`（`IB_HOME_NODE_TOKEN_FILE`） | 人类显式提供的权威文件 |
| `generated` | 首次启动时 `crypto.randomBytes(32)` → base64url（43 字符），原子写（临时文件 + `rename`，`0o600`）到数据目录的 `desktop-credential.json` |

* 生成路径全仓**唯一一处**：`crypto.randomBytes(SECRET_BYTES)`。
* 没有任何硬编码默认 token，没有退化路径（"随机失败就用时间戳"那种）。
* 既有凭据文件坏掉时**不重新生成**（fail closed 并指名那个文件）：覆盖它
  等于把"有人在动它"静默转成"换了个秘密"。
* `describe()` 只输出 `{configured, source, length, fingerprint}`，fingerprint
  是 sha256 前 12 位。

### 2.2 交付面（浏览器怎么拿到它）

浏览器读不了文件系统，而 secret 不许进 HTML / URL / localStorage 明文，因此
需要一条交付通道：`POST /internal/desktop-credential`。

准入规则（四条，每条都拒绝一类具体的攻击者）：

| # | 规则 | 挡住谁 |
| --- | --- | --- |
| 1 | socket 必须 loopback | LAN 上的一切（既有的 `isLoopback()`） |
| 2 | `Origin` 必须**存在**且是 loopback 源 | 远端页面（Origin 是它自己的源）；`Origin: null`（file:// / 沙箱 iframe）；无 Origin 的本地脚本 |
| 3 | `X-IB-Protocol: 1` + `X-IB-Bootstrap: 1` | 把请求挡在 CORS 简单请求集合之外 ⇒ 必然走预检，盲写那条路一并关闭 |
| 4 | token 非空、来源为 generated、自动 provisioning 开着 | 未配置凭据、或部署方已提供凭据的部署（整面 503 fail closed） |

★ **刻意没有"每进程一次"限制**：浏览器只把凭据留在**内存**里，因此用户
刷新页面后必须能再取一次。重复交付不构成权限扩大（交付的是同一份凭据），
真正的边界是第 2 条的 loopback Origin **读**能力。

★ **预检必须允许 `X-IB-Bootstrap`** —— 见 §4 的第 2 个真实缺陷。

### 2.3 浏览器侧

`assets/js/home-node-client.js`：

* `ibHomeNodeEffectiveToken()` —— 显式配置（localStorage）优先，其次是本轮
  会话取到的。**没有第三个来源**。
* `ensureCredential()` 在**每一次请求之前**取凭据（已经取到就立即返回）。
  ★ 顺序是核心：先发再补会让用户先看到一次真实的
  "读不到钱包 / unauthenticated"，几百毫秒后才自愈 —— 用一个假失败回答
  "这台节点现在能不能配"，正是本阶段要消灭的那种错位。
* 401/403 时丢掉本轮那份、重取、**重发一次**（同一个 body、同一个幂等键，
  因此一次性语义不受影响）。Home Node 重启换凭据后页面不会永久 401。
* 凭据**只存在于一个闭包变量**里：不写 localStorage、不写 sessionStorage、
  不进 URL、不进 DOM、不进日志。

### 2.4 UI 真相

* 配置面 `open` 现在由**服务端权威**回答（凭据已配置 ⇒ `/security` 的
  `economyPolicy.configuration.open === true`），UI 不需要、也没有拿到凭据。
* `economy-configuration-core.js` 的 `closedBody` 主语换掉了：旧句"这台设备
  还没有配置本机节点的访问凭据"在正常安装上不再出现，剩下的唯一含义是
  "本机节点这次没有拿到凭据"。`closedTechnical`（环境变量名）逐字保留 ——
  它只在折叠的技术说明里，测试语义未改。
* 技术说明默认折叠这一点由 P22-22 的矩阵继续钉住（86/86 · 157/157 回归通过）。

---

## 3. 测试

### 3.1 `tests/test_p22_23_home_node_provisioning.js`（47/47，已登记进 test-all）

真实 spawn `services/home-node-service.js`（私有端口 + 私有数据目录，
**不设** `IB_HOME_NODE_TOKEN`）。

* **A · fresh install** —— 起点数据目录里没有凭据文件；启动后凭据被自动创造
  且是 CSPRNG（43 位 base64url）；交付面四种准入（外来源 / null / 无 Origin /
  缺头）逐个被拒；预检允许 `X-IB-Bootstrap` 且只对 loopback Origin 回显；
  正规交付拿到的与磁盘上那份**同一指纹**；可重复调用（刷新能再取）；凭据配好
  后桌面面不再匿名可读；配置 seam 打开；**wallet 仍未自动创建**；用户提交
  之后才 mint（`creditMinted:true`）→ wallet READY。
* **B · restart** —— 凭据指纹不变；重放 bootstrap `creditMinted:false`；
  wallet 仍在、balance 一字未变。
* **C · mismatch** —— 401，且 wallet/balance 无任何变化。
* **D · missing Home Node** —— 传输失败（不是 401/403）；客户端把
  "取不到凭据"与"连不上"分成两个不同的码。
* **E · security** —— 凭据不进 stdout/stderr、不进 `/security` 响应体、
  不进 URL、不进 localStorage/sessionStorage、不进 Economy UI 渲染器。
* **F · 源码不变量** —— 生成点唯一、无硬编码默认 token、服务端只在可执行代码
  里解析一次凭据、契约字面量逐字一致。
* **G · override 语义未变** —— env 覆盖照常生效且**整面关闭**交付面、不在
  数据目录另造凭据；显式关掉自动 provisioning ⇒ 回到既有"未配置"形态。

### 3.2 `tests/test_p22_23_first_run_acceptance.js`（24/24，不在 test-all：要开浏览器）

真实 Chromium + 真实 Home Node + 真实静态层，页面经
`http://127.0.0.1:<port>/InternalBeyond.html`（**产品的正常 origin**，不是
file:// —— Chrome 在网络层禁止 file:// 页面访问 loopback）。

1. fresh：**没有**「这里现在还改不了」、**没有** `IB_HOME_NODE_TOKEN` 字样、
   钱包那一格是「尚未完成 Initial Bootstrap」、有输入框与「设置初始额度」、
   凭据不在任何持久存储里。
2. 走完真实两步确认 → 页面进 Wallet READY；权威侧确认
   `cachedBalanceMinor` 与界面输入**换算一致**（2500 → 250000）。
3. Internal / Infernal × 1280 / 390 四张截图，全部 READY 且无横向溢出。
4. **刷新页面**后仍然拿到凭据（READY 照旧、持久存储仍为空）。
5. 秘密纪律：DOM / URL / localStorage / sessionStorage 都没有凭据。

截图落 `%TEMP%\ib-p22-23-shots\`（不入仓库）。全程**一个**浏览器实例。

### 3.3 回归

| 套件 | 结果 |
| --- | --- |
| P22-19 owner scope（core + http） | PASS · 21 项 |
| P22-20 external boundary / public surface | 42 项 · 23 项 PASS |
| P22-21 freeze drift guard / golden path / closure audit | 51/51 · 57/57 · 40/40 |
| P22-2 ~ P22-8 runtime | 全部通过 |
| P22-11 / 13 / 14（command · approval · bootstrap · configuration） | PASS · PASS · 34/34 · 61/61 |
| P22-15/16/17/18/22（UI + visual） | 60/60 · 59/59 · 86/86 · 62/62 · 92/92 · 66/66 · 157/157 · 105/105 |
| `test_home_node_http` / `test_home_node_lan_gate` / production memory assembly | 76 项 · PASS · 24 项 |
| `test_p11_3x_a` security boundary | 60 passed, 0 failed |
| `test_p11_3h` lifecycle gate | PASS |

### 3.4 测试夹具的显式化（不是产品放宽）

自动 provisioning 会**改变**一批既有测试的部署形态：它们真实 spawn 服务、
刻意不设凭据，验的就是"未配置凭据时是什么姿态"。那条路径依然合法（env 是
documented override），因此让它们**显式**声明，而不是依赖一个会随产品演进的
默认值：

* `tests/test-all.js` 给子测试进程设 `IB_HOME_NODE_TOKEN_AUTOPROVISION=0`
  （一处，不漂移；需要验 provisioning 的套件自己设 `1` 覆盖）。
* `tests/test_home_node_production_memory_assembly.js` 与
  `tests/test_m1a_chat_authority_smoke.js` 在自己 spawn 的服务上显式关掉，
  并写明理由。

---

## 4. 本阶段引入并被测试抓住的两个真实缺陷（诚实记录）

1. **`AUTOPROVISION=0` 仍然读了凭据文件** —— 于是"我要构造未配置凭据这个形态"
   的测试会静默地拿着**生产凭据**去跑（实测症状：一条期望匿名可读的断言拿到
   401）。开关现在意味着"这个进程一份都不读"，并且在读文件**之前**就返回。
2. **预检里引用了一个作用域外的 `path`** —— `ReferenceError` 让**每一个带
   Origin 的 OPTIONS 预检都挂死**（客户端超时 / Failed to fetch，服务端日志
   里只有一条 uncaught-exception）。这直接打断产品的正常启动链，因此
   `Access-Control-Allow-Headers` 那一行必须同时补上 `X-IB-Bootstrap` 并且
   路径从 `url` 自己算。测试里加了预检断言（loopback 回显 / 外来源不回显）。

两条都是"看起来正常的失败"：一条让测试以错误的方式通过，另一条让请求根本
不到服务端。它们只有靠真实进程 / 真实浏览器才暴露得出来。

---

## 5. Stop Gate 逐条回答

1. **正常 Desktop 用户还需要手工设 `IB_HOME_NODE_TOKEN` 吗？** 不需要。它现在是
   developer / headless / 测试的 override。
2. **唯一 authority 是谁？** `services/home-node/desktop-credential.js`
   （校验者即持有者）。
3. **谁生成？** 它。`crypto.randomBytes(32)` → base64url。
4. **谁保存？** 它。原子写到 `<dataDir>/desktop-credential.json`（`0o600`）。
5. **谁传给 Home Node？** 同一个模块在服务启动时解析一次，结果注入
   `http.js` 的 `token` 与两个 Economy seam。
6. **谁传给 canonical client？** `POST /internal/desktop-credential`
   （仅 loopback + loopback Origin + 协议头），浏览器存**内存**。
7. **restart 后如何恢复？** 读同一份文件（指纹不变），浏览器重新取一次。
8. **secret 可能进 DOM / log / export / URL / localStorage 吗？** 不会。
   E 组 7 条 + 浏览器 5 条断言。
9. **Home Node 未运行与凭据缺失能区分吗？** 能：前者是传输层
   `home-node-unreachable`，后者是 `home-node-credential-unavailable` /
   `/security` 的 `bootstrap.unavailableReason`。
10. **Initial Bootstrap 仍只能一次吗？** 是（重放 `creditMinted:false`，余额不变）。
11. **没有自动发放默认额度吗？** 没有（A8：凭据自动 provision **不**创建 wallet）。
12. **没有新增 raw mint / ledger / transfer 吗？** 没有。
13. **没有新增 `/economy/*` write 吗？** 没有（交付面在 `/internal/` 下，
    且不触任何经济面）。
14. **没有扩大 Agent/User capability 吗？** 没有。
15. **fresh install 能只靠 GUI 完成吗？** 能（§3.2 走完全程）。
16. **restart 保持 wallet 与 balance 不变吗？** 是。
17. **mismatch fail closed 吗？** 是（401 且无 mutation）。
18. **P22-19～22 回归通过吗？** 是。
19. **production 修改了哪些文件，为什么每一个都必要？**

| 文件 | 为什么必要 |
| --- | --- |
| `services/home-node/desktop-credential.js`（新） | 唯一 authority：生成 / 持久化 / 加载 / 诊断 |
| `services/home-node-service.js` | 用 authority 取代裸 `process.env`；凭据失败时不带空凭据启动；把来源与开关交给传输层；导出诊断投影 |
| `services/home-node/http.js` | 交付面 + `/security` 的三个事实 + 预检允许交付头（+ 修掉作用域缺陷） |
| `assets/js/home-node-client.js` | 自举凭据（仅内存）、请求前取凭据、401/403 重取一次 |
| `assets/js/economy-configuration-core.js` | `closedBody` 主语换成"本机节点"（该状态在正常安装上不再出现） |
| `tests/test-all.js` | 测试夹具显式关掉自动 provisioning（一处） |
| `tests/test_home_node_production_memory_assembly.js` · `tests/test_m1a_chat_authority_smoke.js` | 同上，各自写明理由 |

20. **child/spawn/browser/socket/temp/leftover？** provisioning 套件 0 残留子进程、
    4 个临时目录尽力清理；验收套件 3 个子进程（Home Node / 静态层 / 一个浏览器）
    全部请求退出、2 个临时目录尽力清理。

---

## 6. 未做（§11 禁止范围）

P23 · Android 实现 · Exchange · Refund · Provider quota/billing/top-up ·
真实支付 · Merchant · 人类直购 · 商店管理 · Economy schema 迁移 ·
新 Economy capability / event type / mutation endpoint · UI 大改版 ·
Release Builder 修改。

另外**没有顺手修**的两处既有问题（都不在本阶段范围内，且都用基线对比确认过
与本次改动无关）：

* `tests/test_p11_3a_device_token_boundary.js` 的 D0/D2：该测试的变异锚点用
  LF 字面量，而 `core.autocrlf=true` 让它读到 CRLF，锚点匹配失败。该文件
  **不在** `test-all.js` 里。
* `tests/test_m1a_chat_authority_smoke.js` 的 5 项失败：它走
  `/characters/publish` 与 `/pairing/session`，而 P11-3A 的凭据铸造门在未配置
  凭据时对那几条路径就是 403。**stash 到 HEAD 基线后同样失败**，与本阶段无关。
