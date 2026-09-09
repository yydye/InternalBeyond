# P3 · User-Facing Error Productization 实施报告

**状态**：完成，停在 P3（未进入 P4）。
**目标**：普通用户不再直接面对 HTTP 状态码 / WebSocket 地址 / Node / 端口 / 堆栈；同时保留开发者可展开的原始诊断信息，且详情也必须脱敏。

---

## 1. 修改文件

| 文件 | 类型 | 内容 |
|---|---|---|
| `assets/js/error-catalog.js` | 扩展 | 保留原 11 类与 `classify/text/err/report`；新增 5 类、统一用户错误模型 `present/model`、脱敏、最小错误卡片 UI `show` |
| `assets/js/communication.js` | 修改 | 单聊 / 群聊失败提示、缺密钥 / 缺地址前置守卫接入统一模型（**未触碰同文件里另一会话的 C2 快照改动**） |
| `assets/js/bridge.js` | 修改 | 10 处 `Bridge 未连接` toast、DIY 面板 3 处状态文案、常驻会话 select、TTS 生成/播放失败 → 统一模型 + 重试 |
| `assets/js/active-diary.js` | 修改 | 后台服务请求错误标注来源、健康检查、发送历史、计划保存、主动消息发送失败 |
| `assets/js/memory.js` | 修改 | 3 处原始 `e.message` toast（生成一句话 / 生成记忆 / 封档） |
| `assets/js/moments.js` | 修改 | 动态流加载失败、观测数据导出失败 |
| `assets/js/social.js` | 修改 | 参考音频上传 / 删除、API 配置保存失败 |
| `assets/js/workspace.js` | 修改 | 续写失败 |
| `assets/js/app-store.js` | 修改 | 应用启动失败 |
| `assets/js/local-first.js` | 修改 | 本机模型探测 / 保存失败 |
| `test_error_catalog.js` | 重写 | P1/P2 断言全保留 + P3 专项（124 项） |
| `test_error_ui_smoke.js` | 新增 | 最小浏览器 smoke（20 项，真实 Chrome + 真实主 UI） |
| `test-all.js` | 修改 | 注册 `test_error_ui_smoke.js` 到 browser 组 |
| `docs/history/zero-setup/P3-ERROR-PRODUCTIZATION-REPORT.md` | 新增 | 本报告 |

**未触碰**：`InternalBeyond.html`（`error-catalog.js` 早已在 3345 行加载，无需新增脚本标签）、`middle-brain.js`（另一会话在途编辑，见 §12.2）、Bridge/Active 服务端、`local-services-runner.js`、`boot-state.js`、`launch-internal-beyond.js`。
所有改动文件的 UTF-8 BOM 已核对并恢复（编辑工具会剥离 BOM，已用脚本逐文件补回，见 §11）。

---

## 2. 原有 error-catalog 审计结果

**已有类别（11）**：`network / timeout / rate_limit / auth / provider / model / bad_request / empty_output / content / aborted / unknown`。

**已有 API**：`classify(err)`、`text(category, roleKeyOrCfg)`（角色口吻文案，2–3 条变体按角色哈希稳定取一条）、`err(category)`、`report(err, ctx)`（Console 完整诊断 + `{category,text,dup}`）。

**使用点（改前只有 1 个文件）**：`assets/js/communication.js` 的 4 处 —— 群聊空回复气泡（1759）、群聊 catch（1818）、单聊空回复 throw（2100/2160）、单聊 catch（2233）。其余模块**完全没有接入**。

**错误传播链（实测代码路径）**

```
provider HTTP → _ibApiPost()（Bridge-aware fetch，失败回落直连）
   ↓
callApiChatStream / callApiChat / callApi
   · `new Error(res.status + ': ' + bodyText)`   ← 上游原始 body 直接进 message
   · `new Error('API返回 ' + res.status)`        ← callApi 非流式
   · `new Error('请求超时（60秒）…')` / HTML 而非 JSON / JSON 解析异常
   ↓
sendChatMessage catch（单聊 2233 / 群聊 1818）
   ↓
IBERR.report → console.error 完整诊断 → toast + 聊天气泡（角色口吻文案）
```

**改前「错误来源 → 分类 → 展示」矩阵**

| 来源 | 改前分类 | 改前展示 | 问题 |
|---|---|---|---|
| provider 401 | `auth` | 角色口吻气泡 | 无状态码/无详情，但用户不知道要去改密钥 |
| provider 403 | `auth` | 同上 | **误判成密钥问题**（实际可能是区域/权限/内容策略） |
| provider 404 | `model` | 同上 | **端点地址写错也被说成"模型不可用"** |
| provider 429 | `rate_limit` | 同上 | 文案已中性，可用 |
| provider 5xx | `provider` | 同上 | 可用 |
| timeout / 网络 | `timeout` / `network` | 同上 | 可用 |
| 响应非 JSON | `unknown` | 同上 | 用户看不到"地址可能写错"这一真正原因 |
| Bridge 连接失败 | 不经过 catalog | `ibToast('Bridge 未连接')` ×10、面板 `Bridge 未连接。` ×3 + **`ws://127.0.0.1:23115` + `start-bridge-service.cmd` 提示** | 普通提示里直接出现地址与命令行 |
| Active 后台服务 | **不经过 catalog** | `toast('未检测到后台服务，请先运行 start-active-service.cmd')`、`'发送失败：' + h.error` | 命令行提示 + 原始错误正文 |
| Active HTTP 5xx | **被误判为 provider 5xx** | `'后台服务 500: …'` 原样进模型 | 本地服务错误伪装成 AI 服务错误 |
| TTS 生成失败 | 不经过 catalog | `ibToast('TTS 未配置')` / `'Bridge TTS 未配置，已用浏览器语音朗读'` | 无"不影响文字聊天"的能力说明，无重试入口 |
| 各处 `catch` 原始 message | 不经过 catalog | `toast('请求失败：'+e.message)` 等 **13 处**（memory 3、moments 1、social 6、workspace 1、app-store 1、local-first 2、middle-brain 1、active-diary 4、bridge 7） | 原始 message / 状态码 / URL 直接进 UI |

---

## 3. 是否扩展了现有 catalog / 扩展了哪些 code

**是，在同一个 `error-catalog.js` 内扩展，没有第二套分类体系。**

新增 5 个类别：`forbidden`、`endpoint`、`malformed`、`local_service`、`tts`（共 16 类）。

**分类行为调整（基于真实行为，不是字符串硬凑）**

| 调整 | 改前 | 改后 | 依据 |
|---|---|---|---|
| 403 | `auth` | **`forbidden`** | 403 是权限/区域/拒绝，与密钥无效不是一回事（`test_error_catalog.js` 断言同步更新，已在注释中标注） |
| 404 | `model` | 命中模型关键词 → `model`；否则 **`endpoint`** | 真实 body 里 `"model ... does not exist"` 才归模型；纯 404 是地址问题 |
| 408 | `bad_request` | **`timeout`** | 语义就是超时 |
| 网页/非 JSON 响应 | `unknown` | **`endpoint`** | 底层 throw 的文案本身在说"检查端点 URL" |
| JSON 解析异常 | `unknown` | **`malformed`** | 服务端返回不可识别数据 |
| `fetch failed` / `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT` / `ENOTFOUND` / `socket hang up` | 部分漏判 | **`network`** | 需求点名 `fetch failed` |
| 本地服务 500/404 | 误判 `provider`/`model` | **`local_service`**（按来源判定，优先于状态码） | 见 §5 |
| TTS | 无 | **`tts`** | 语音失败与聊天失败是两回事 |

**稳定 code（机器可读，P5 可直接用）**

```
IBERR.AUTH.401 / .403→IBERR.FORBIDDEN.403 / IBERR.ENDPOINT.404 / IBERR.RATE_LIMIT.429 /
IBERR.PROVIDER.500 / IBERR.TIMEOUT.TIMEOUT / IBERR.NETWORK.UNREACHABLE /
IBERR.MALFORMED.BAD_RESPONSE / IBERR.MODEL.NOT_FOUND /
IBERR.LOCAL_SERVICE.BRIDGE|ACTIVE|STATIC|VISION|RESTART /
IBERR.TTS.FAILED | .PLAYBACK / IBERR.AUTH.MISSING / IBERR.ENDPOINT.MISSING /
IBERR.EMPTY_OUTPUT.EMPTY / IBERR.CONTENT.BLOCKED / IBERR.BAD_REQUEST.REJECTED /
IBERR.ABORTED.STOPPED / IBERR.UNKNOWN.UNKNOWN
```

---

## 4. 用户错误模型 schema

```js
IBERR.present(err, ctx) → {
  code:             'IBERR.AUTH.401',       // 稳定机器标识
  category:         'auth',                 // 16 类词表之一
  title:            'API 密钥无法使用',       // 普通 UI 只读这三个
  message:          '…',                    // 「发生了什么」
  suggestion:       '…',                    // 「可以做什么」
  retryable:        false,                  // 同请求重发是否有意义
  action:           { type:'open_settings', target:'api', label:'打开设置' } | null,
  technicalDetails: {                        // 只有「查看详情」才展示，已脱敏
    '错误代码','类别','HTTP 状态','服务商','模型','配置 ID','发生位置',
    '本地组件','接口地址','请求 ID','错误类型','原始信息','调用栈','时间'
  }
}
```

- `ctx` 只读取白名单键：`cfg / friendId / senderName / stage / source / component / status / endpoint / provider / model / requestId / reason / detail / raw / time`；**绝不 stringify 整个 `cfg` 或异常对象**，`requestBody` / `messages` / `prompt` 即使传入也被忽略（有专项断言）。
- `IBERR.model(category, ctx)`：没有 Error 对象时直接构造（例如"还没配置密钥"的前置守卫）。
- `IBERR.report(err, ctx)` 保持向后兼容，返回 `{category, code, text, dup, model}`，`text` 仍是角色口吻文案，Console 诊断字段只增不减。
- 普通 UI 默认只使用 `title + message + suggestion`；`retryable` 与 `action` 决定按钮。

---

## 5. 验收场景实际文案

| 场景 | code | title | message | suggestion | retryable |
|---|---|---|---|---|---|
| 401 密钥无效/过期/未配置 | `IBERR.AUTH.401` | API 密钥无法使用 | AI 服务拒绝了这次请求，通常是密钥无效、已过期，或者没有正确填写。 | 打开「API 设置」检查这个模型对应的密钥，保存后再试。 | ✗（给「打开设置」） |
| 完全没配密钥 | `IBERR.AUTH.MISSING` | 还没有配置 API 密钥 | 这个模型还没有可用的密钥（或本机端点），所以没法开始对话。 | 打开「API 设置」填入密钥后保存，再回来发送。 | ✗ |
| 403 权限/区域/拒绝 | `IBERR.FORBIDDEN.403` | AI 服务拒绝了这次请求 | 服务商没有允许这次访问，可能是账号权限、所在地区或内容策略限制。 | 如果反复出现，请确认该账号可用的范围，或换一个模型 / 服务商再试。 | ✗ |
| 404 地址错 | `IBERR.ENDPOINT.404` | API 地址可能不正确 | 请求发到了这个地址，但没有拿到可用的接口响应。常见原因是地址不完整（例如少了 /v1/chat/completions），或填成了中转站首页。 | 打开「API 设置」核对接口地址，确认它指向完整的对话接口后重试。 | ✗ |
| 404 / 400 模型不存在 | `IBERR.MODEL.NOT_FOUND` | 当前模型不可用 | 服务商没有找到这个模型，或者你的账号暂时还不能使用它。 | 打开「API 设置」换一个可用模型，或核对模型名称是否与服务商文档一致。 | ✗ |
| 429 | `IBERR.RATE_LIMIT.429` | AI 服务暂时拒绝了请求 | 可能是请求过于频繁，或账户额度受限。 | 稍等一会儿再试；如果一直出现，请检查账户余额或用量限制。 | ✓ |
| 5xx | `IBERR.PROVIDER.500` | AI 服务暂时异常 | 服务商这一侧出了状况，不是你的配置问题。 | 稍等片刻再试；如果持续出现，可以换一个模型或服务商。 | ✓ |
| 超时 | `IBERR.TIMEOUT.TIMEOUT` | 请求超时 | 等了很久都没有收到回复，可能是网络较慢，或对方响应太慢。 | 检查网络后重试；如果经常发生，可以换一个更快的模型或服务商。 | ✓ |
| 网络/代理失败 | `IBERR.NETWORK.UNREACHABLE` | 连接不上网络 | 请求没有发出去，可能是断网，或代理、防火墙拦住了连接。 | 确认网络可用（或关闭代理）后再试一次。 | ✓ |
| 响应无法识别 | `IBERR.MALFORMED.BAD_RESPONSE` | AI 服务返回了无法识别的数据 | 对方返回的内容不是预期格式，可能是中转站或服务商临时异常。 | 重试一次；如果反复出现，请检查接口地址和服务商状态。 | ✓ |
| 408 | `IBERR.TIMEOUT.408` | 同「超时」 | | | ✓ |
| 内容策略拦截 | `IBERR.CONTENT.BLOCKED` | 这条内容被服务商拦下了 | 服务商的内容策略不允许生成这条回复。 | 换个说法或换个话题再试。 | ✗ |
| 空回复 | `IBERR.EMPTY_OUTPUT.EMPTY` | 没有收到有效回复 | AI 这次没有返回内容。 | 再发一次，或换个说法试试。 | ✓ |
| 其他未预料 | `IBERR.UNKNOWN.UNKNOWN` | 出现了未预料的问题 | 这次请求没有完成，暂时无法判断具体原因。 | 重试一次；如果反复出现，可以展开「查看详情」把信息反馈给我们。 | ✓ |

**429 明确不写"余额不足"**：文案用"可能是请求过于频繁，或账户额度受限"，并有断言 `!/余额不足/`。

---

## 6. Bridge / Active / TTS 文案

统一走 `local_service`（组件词表与 **P2 boot-state 完全一致**：`bridge / active / static / vision / restart`）与 `tts`：

| 组件 | code | title | message | suggestion | retryable |
|---|---|---|---|---|---|
| Bridge | `IBERR.LOCAL_SERVICE.BRIDGE` | 部分本地功能暂时不可用 | 本地增强服务没有响应。你仍然可以继续聊天。 | 可以重试；如果一直失败，请重新启动 InternalBeyond。 | ✓ |
| Active | `IBERR.LOCAL_SERVICE.ACTIVE` | 后台功能暂时不可用 | 主动消息等后台功能没有运行。聊天不受影响。 | 可以重试；如果一直失败，请重新启动 InternalBeyond。 | ✓ |
| Vision | `IBERR.LOCAL_SERVICE.VISION` | 本地视觉识别暂不可用 | 图片识别功能没有运行，其它功能不受影响。 | 需要识别图片时，可以改用支持看图的模型。 | ✗ |
| Static（fatal） | `IBERR.LOCAL_SERVICE.STATIC` | 主界面服务异常 | 页面依赖的本地服务没有正常启动。 | 请重新启动 InternalBeyond；如果仍然打不开，可以查看启动日志。 | ✗ |
| 重启控制 | `IBERR.LOCAL_SERVICE.RESTART` | 重启控制暂不可用 | 重启后台服务的入口没有响应，其它功能不受影响。 | 可以稍后重试，或手动重新启动 InternalBeyond。 | ✓ |
| TTS 生成 | `IBERR.TTS.FAILED` | 语音生成失败 | 这次没有生成语音，文字聊天不受影响。 | 可以重试；已为你改用浏览器朗读。 | ✓ |
| TTS 播放 | `IBERR.TTS.PLAYBACK` | 语音播放失败 | 这段语音没能播放出来，文字内容不受影响。 | 再点一次播放试试。 | ✓ |

- Bridge 的连接细节（`ws://127.0.0.1:23115`、`ECONNREFUSED`）只在「查看详情」里出现；普通提示只有能力影响。
- Active 的 HTTP 错误通过 `err.ibSource='local_service'` + `err.ibComponent='active'` 标注来源，**不会被分类成 provider 5xx**。
- 主动消息发送历史：正文只写「发送失败 · 本地增强服务没有响应。你仍然可以继续聊天。」，原始 `h.error` 放 `title` 供排查。

---

## 7. 「查看详情」行为

- 卡片结构：`title` / `message` / `suggestion` + `[查看详情] [打开设置?] [重试?] [✕]`，全部内联样式、零 CSS 文件改动、零 HTML 改动。
- 点击「查看详情」→ 卡片内展开 `<pre>`（`textContent`，无 HTML 注入面），内容为 `IBERR.detailsText(model)` 的「键：值」逐行文本；再次点击收起。
- 展示内容（有则显示）：HTTP 状态、接口地址（query 中密钥已掩码）、服务商、模型、配置 ID、发生位置、本地组件、请求 ID、错误类型、**原始信息**（上游 body，脱敏 + 截断 600 字）、**调用栈**（截断 1200 字）、时间。
- 行为细节：同 `code` 2.5s 内去重；最多同屏 3 张卡；30 秒自动收起（鼠标悬停或已展开详情则保留）；`✕` 立即关闭；`IBERR.hideAll()` 供测试/清理。
- 「重试」只在 `model.retryable === true` **且调用方提供 `onRetry`** 时出现（= 已有能力，不新增后台动作）：
  - Bridge 各按钮操作 → 回调即"再点一次刚才那个按钮"（`ibRetryBtn(el)`）；
  - TTS 生成/播放 → 重试即重新点播/重新合成；
  - Active 健康检查 → 回调 `_activeCheckCompanion(true,true)`。
- 「打开设置」使用既有 `navTo('api')`，仅在 `window.navTo` 存在时渲染。

---

## 8. 脱敏规则

技术详情、`IBERR.redact()`、`IBERR.redactUrl()` 共用同一套规则（键名 + 值形双保险）：

1. **头部字段**：`Authorization` / `Proxy-Authorization` / `x-api-key` / `api_key` → 值掩码；`Cookie` / `Set-Cookie` 因分隔符是 `;`，整行掩码。
2. **查询串**：`?key=` / `&api_key=` / `&token=` / `&access_token=` / `&refresh_token=` / `&id_token=` / `&sig=` / `&signature=` / `&password=` / `&secret=` / `&auth=` 的值 → `********`（Gemini 的 `?key=` 在这里被覆盖）。
3. **JSON 字段**：键名命中 `apiKey|api_key|authorization|auth|bearer|token|access_token|refresh_token|id_token|secret|client_secret|password|passwd|pwd|cookie|set-cookie|session|sessionid|credential|signature|sig|private_key|client_id` 的值 → `********`（`"api_key":"…"`、`'password': '…'` 两种引号都覆盖）。
4. **已知密钥形状**：`sk-…`、`sk_live_/sk_test_…`、`AIza…`、`xai-…`、`hf_…`、`ghp_…`、`github_pat_…`、`AKIA…`、JWT（`eyJ….….…`）、`Bearer <token>`。
5. **大块二进制**：`data:image/...;base64,...` 与任意 ≥80 字符的 base64/十六进制块（图片、音频、签名体）→ `********`。
6. **兜底**：控制字符清理、连续空白压缩、长度截断（原始信息 600 / 调用栈 1200 / URL 300）。
7. **绝不进详情**：请求体、用户 prompt、聊天正文、`cfg.apiKey`、整个异常对象、整个 `cfg`。

**专项断言**（`test_error_catalog.js` + `test_error_ui_smoke.js`）覆盖：API Key、Bearer、Authorization 头、Cookie、JSON 敏感字段、Gemini `?key=`、data:base64、JWT、AWS key，以及"传入 `requestBody`/`messages`/`prompt` 后详情里查不到用户正文"。

---

## 9. 修改了哪些现有错误入口

| 入口 | 改前 | 改后 |
|---|---|---|
| 单聊失败（`communication.js` 单聊 catch） | `toast(角色文案)` + 气泡 | `IBERR.show(model)` + 气泡（气泡保留角色口吻，卡片给产品文案与详情） |
| 群聊失败（群聊 catch） | 同上 | 同上（成员级失败不影响其他成员） |
| 缺密钥 / 缺地址守卫 | `toast('请先在 API 页面配置密钥…')` | `IBERR.show(IBERR.model('auth'/'endpoint',{reason:'missing-…'}))` + 「打开设置」 |
| Bridge 操作失败 ×10 | `ibToast('Bridge 未连接')` | `ibErrLocal('bridge',err,ibRetryBtn(btn))` |
| Bridge 面板 / 表情 / 常驻会话 / 消息流 ×6 | `Bridge 未连接。`、含 `ws://127.0.0.1:23115` 与 `start-bridge-service.cmd` 的指引 | 能力层面文案；URL/命令不再出现在普通提示 |
| TTS 生成 / 播放失败 | `ibToast('TTS 未配置'/'语音播放失败')` | `IBERR.TTS.FAILED / PLAYBACK` + 重试 |
| Active 健康检查 / 发送历史 / 计划保存 / 主动消息 ×4 | 命令行提示、`h.error`、`e.message` | `local_service/active` 模型 + 详情 |
| 记忆：一句话 / 生成 / 封档 ×3 | `'请求失败：'+e.message` 等 | `IBERR.present(e,{stage})` |
| 动态流加载 / 导出 ×2 | `e.message` 截断上屏 | 产品文案 + `title` 详情 |
| 参考音频上传 / 删除 / API 配置保存 ×3 | `e.message` 截断上屏 | `IBERR.present/present(...,{source:'local_service'})` |
| 工作区续写 | `'续写失败：'+e.message` | `IBERR.present(e,{stage:'workspace_continue'})` |
| 应用启动失败 | `'应用启动失败：'+e.message` | `IBERR.present(e,{stage:'app_launch'})` |
| 本机模型探测 / 保存 ×2 | `error.message` 上屏 | `local_service` 模型 + `title` 详情 |

**共 13 个文件、约 40 个错误入口接入；原始 `console.error` / `[IB API错误]` / `[IB请求失败]` 诊断全部保留、未削弱。**

---

## 10. 专项测试

| 测试 | 结果 | 覆盖 |
|---|---|---|
| `node test_error_catalog.js` | **124 / 124 ✔** | 原有分类回归（含 403 变更）、16 类文案、模型 schema、retryable 矩阵、code 稳定性、技术详情字段、脱敏 10 组、`report()` 向后兼容 |
| `node test_error_ui_smoke.js` | **20 / 20 ✔**（自然退出，无 LEAK） | 真实 Chrome + 真实主 UI：卡片渲染、普通提示无 `127.0.0.1/ws:///http:///ECONNREFUSED/sk-/401`、详情默认收起、展开后含 HTTP 状态/地址/请求 ID/原始信息/调用栈且无 API Key、Bridge 能力文案 + URL 只在详情、重试回调只触发一次、打开设置跳 `page-api`、TTS 文案、去重与 `hideAll`、无未捕获异常 |

模块相关最小测试（未跑全量 browser suite）：
- `node --check` 全部 10 个被改 JS 文件 + 2 个测试文件：通过；
- `test_frontend_structure.js`（含 BOM 校验）：通过（唯一失败见 §12.2）；
- `test_bridge.js` / `test_active_http.js` / `test_local_services_runner.js`：随 service 回归全绿；
- 主 UI 脚本加载：10 个被改文件全部由 `InternalBeyond.html` 直接加载，smoke 的"无未捕获异常"覆盖了加载与语法。

---

## 11. quick 回归

```
node test-all.js --quick
  static  33 项 · 36.3s · 1 失败
  service 16 项 · 85.4s · 全部通过
  总耗时 121.7s
```

- 唯一失败：`test_frontend_structure.js → encoding.bom.assets\js\middle-brain.js`（**P3 未触碰该文件**，见 §12.2；HEAD 有 BOM、工作树没有，属另一会话在途编辑）。
- 被改文件 BOM 已逐文件核对恢复（编辑工具会剥掉 BOM）：`error-catalog / communication / bridge / active-diary / memory / moments / social / workspace / app-store / local-first` 现均为 `EF BB BF`，且 `git diff` 无行尾批量改写。

---

## 12. 已知限制 / P5 可复用接口

### 12.1 P5 可直接复用的接口（禁止再造第二套）

```js
IBERR.present(err, ctx)      // 任何 Error → 统一模型（含 source/component 语义）
IBERR.model(cat, ctx)        // 无 Error 对象时构造（前置守卫）
IBERR.report(err, ctx)       // Console 诊断 + {category, code, text, dup, model}
IBERR.show(model, {onRetry}) // 最小卡片（P5 应复用模型层；如需 Diagnostics 页面，
                             //   直接渲染 model.technicalDetails / detailsText(model)）
IBERR.detailsText(model)     // 脱敏后的「键：值」纯文本
IBERR.redact(str) / redactUrl(url)
IBERR.CATEGORIES / codeOf / statusOf / classify / text
```

- 与 P2 boot-state 对齐：`local_service` 的 `component` 词表 = boot-state 的 `components` 键（`bridge/active/static/vision/restart`）；`bootState.components.*.reason.category` 作为 `ctx.detail` 传入即自动进入「查看详情」。**P5 不要重新发明本地服务状态判断**。
- 渲染约定：`probed:false` / `affectsOverall:false` 不得渲染成故障；`stale:true` 不得假绿（沿用 P2 契约）。

### 12.2 已知限制

1. **聊天失败没有「重试」按钮**：应用内没有"重新发送上一条"能力，`retryable` 虽为 true 但无 `onRetry` 回调，故只显示「查看详情」。属于"不新增能力"的取舍，P4/P5 若要加需单独设计。
2. **`middle-brain.js` 保存失败仍显示原始 message**（1 处）：该文件正被另一会话在途编辑（工作树 07:46、`git diff` 34 行、BOM 已丢），P3 未认领/未触碰以免打断其工作。接入只需一行 `IBERR.show(IBERR.present(e,{stage:'middle_brain_save'}))`。
3. **Bridge 业务级 `j.error`（服务端返回的 2xx/4xx 业务错误）仍原样展示**：如"写入失败：…""创建失败：…"。它们不是 HTTP/URL/堆栈泄漏，且多为可操作提示（如 TTS 未配置 503），P3 保持原样；P5 可统一纳入。
4. **错误卡片是轻量 DOM 组件**（内联样式、无 CSS 文件改动）：未做主题变量全覆盖与键盘焦点管理；P5 Diagnostics 页应复用模型层，不要复制这套 DOM。
5. **调用栈含本地文件路径**（浏览器端 `http://127.0.0.1:<port>/assets/js/...`）：属开发者信息且已脱敏密钥；若发行版要求隐藏路径，需在 `redact()` 增加路径掩码。
6. **卡片 30 秒自动收起**（悬停或展开详情则保留）：长时间离开可能错过详情入口；聊天气泡仍是永久记录，但气泡不带详情按钮。
7. **无错误上报/统计**：仅 Console + UI，未做聚合或上报（P5 若需要，`code` 已可作维度）。
8. **P3 未改 `local-first.js` 的 localhost 说明文案**（"探测仅允许 localhost / 127.0.0.1 端点"）：这是**功能约束说明**而非错误泄漏，保留；P6 教程可改写。

### 12.3 明确未做（P3 范围外）

Diagnostics 独立页（P5）、First-run 向导（P4）、教程（P6）、Provider editor 重构、大规模视觉重构、错误上报、聊天"重新发送"能力。
