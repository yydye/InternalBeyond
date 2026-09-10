# InternalBeyond · 发布契约（Release Contract）

> 本文档回答「一次发行是怎么产出、怎么上传、客户端读到什么」。
> 决策依据见 [DECISIONS.md](DECISIONS.md) U 系列；更新功能本身的机制见
> [ARCHITECTURE.md](ARCHITECTURE.md)；用户视角的安装/升级说明见 [README.md](../README.md)。
>
> **本文档是发行契约的唯一真源。** 代码里的对应真源只有一个：
> `runtime/update-manifest.js`（schema + 唯一 URL 构造 + 客户端校验）。

---

## 1. 一次发行产出什么

| 产物 | 位置 | 上传为 Release asset |
|---|---|---|
| `InternalBeyond-Setup-<version>.exe` | `dist\` | ✅ |
| `SHA256SUMS.txt` | `dist\` | ✅ |
| `update-stable.json` | `dist\` | ✅ **最后** |

产物全部由一条命令产出，`dist\` 不进版本库（`.gitignore`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1 `
  -NotesFile docs\release-notes\1.0.1.md
```

`-ReleasedAt` / `-NotesFile` / `-MinimumVersion` 都是**可选**的，见 §4 / §8。
1.0.1 刻意**两个都不传**：不传 `-ReleasedAt`（构建时刻不是发布时刻，见 §4），
不传 `-MinimumVersion`（理由见 §8）。

---

## 2. 上传顺序是契约，不是偏好

```
1) InternalBeyond-Setup-x.y.z.exe
2) SHA256SUMS.txt
3) update-stable.json          ← LAST
```

客户端读取的稳定地址是：

```
https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json
```

**上传 `update-stable.json` 这个动作本身，就是「这个版本进入 Stable 通道」的时刻。**
在它上传之前，客户端完全不知道这个版本存在——所以一个只上传了 exe、还没上传清单的
半成品发行，对客户端是不可见的，这正是我们想要的失败姿势。

反向推论（同样重要）：**不要把清单先传上去**。先传清单再传 exe，会让客户端在一段
窗口期内拿到一份指向尚不存在（或尚未传完）的资产的清单。

### 2.1 客户端怎么读到它：一条主路 + 一条只在网络失败时启用的备路（U-D1 Revised）

```
primary   GET https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json
             │
             ├─ 拿到完整响应实体 ──► 解析 → 校验 → 比较版本。**到此为止，不再走别的路。**
             │
             └─ 连一个完整响应实体都没拿到（DNS/超时/重置/不可达/TLS/跳转 hop 传输失败）
                    │
                    └─► fallback  GET https://api.github.com/repos/yydye/InternalBeyond/releases/latest
                                   仅接受 draft === false 且 prerelease === false
                                   且资产名精确等于 update-stable.json
                                   → 经资产 API/CDN（api.github.com/.../releases/assets/<id>）取同一份清单
```

- **备路不是第二真源**：两条路取到的是**同一个 Release asset**。schema、校验、semver 比较
  完全共用同一套代码（`runtime/update-manifest.js` + `runtime/update-check.js`），没有第二份实现。
- **只在「没拿到完整响应实体」时启用**。一旦拿到过响应，其后任何问题——404、403、
  429 限流、非法 JSON、schema 不符、hash 非法、installer URL / 版本 / 资产身份不一致、
  跳转目标不在白名单——都是 **hard failure**，如实降级为「本次无更新信息」，
  **绝不换路径重试**（换路径等于让第二条路推翻一条校验结论）。
  实现上是一个可审计的等式：`fallbackAllowed(result) === (result.outcome === 'network')`。
- **跳转白名单**：`github.com`、`api.github.com`、`objects.githubusercontent.com`、
  `release-assets.githubusercontent.com`。**每一跳**都校验（重定向由代码手动跟随，不交给
  HTTP 客户端自动跟随），跳到白名单外即安全拒绝，且不构成走备路的理由。
- **无需任何凭据**：匿名只读，不引入 token / 登录 / 额外配置。API 限额 60 次/小时/IP，
  只在 primary 网络失败时消耗，且不重试。

### 2.2 载荷（exe 本身）走同一条规则（U-D6）

U-D1 Revised 只管「读清单」。**下载安装包本体**走的是同一套判定，冻结为 U-D6：

```
primary   GET manifest.installer.url            （版本钉死的 release asset URL）
             │
             ├─ 拿到完整响应实体 ──► 四道校验（见 §5.1）。**到此为止，不再走别的路。**
             │
             └─ 连一个完整响应实体都没拿到（DNS/超时/重置/不可达/TLS/中途断流）
                    │
                    └─► fallback  GET .../releases/latest
                                   仅接受 draft === false、prerelease === false、
                                   tag 精确等于 v<manifest.version>、
                                   资产名精确等于 InternalBeyond-Setup-<manifest.version>.exe
                                   → 经资产 API/CDN 下载**同一个 exe**
```

- **备路只是传输替代**，不是第二发布真源：放行依据仍然是 manifest 里那一个 sha256，而且
  **必须对本地下载文件重新计算**。API 元数据里的 `asset.digest`（如存在）必须等于
  `sha256:<manifest.installer.sha256>`，不等即 hard failure；**缺失不单独构成失败**。
- **禁止备路的情形**（全部是 hard failure，本次安装失败，不换路、不重试）：HTTP 4xx/5xx、
  wrong asset、wrong release/tag、invalid Content-Length（缺失也算）、size mismatch、
  sha256 mismatch、PE ProductVersion/FileVersion mismatch、任何安全校验失败。
- **发布者的责任没有变化**：备路不能救一个「资产名不对 / 版本没钉死 / digest 对不上」的
  release。§2 的上传顺序与 §5 的构建期闸门仍然是唯一正确的做法。

---

## 3. 清单长什么样

```json
{
  "schema": "internalbeyond.update",
  "schemaVersion": 1,
  "channel": "stable",
  "version": "1.0.1",
  "installer": {
    "url": "https://github.com/yydye/InternalBeyond/releases/download/v1.0.1/InternalBeyond-Setup-1.0.1.exe",
    "sha256": "<64 位小写十六进制>",
    "sizeBytes": 50828077,
    "productVersion": "1.0.1"
  },
  "releasedAt": "<ISO-8601 UTC 的实际发布时刻；写不出就整个字段不出现>",
  "notes": "面向普通用户的更新说明（纯文本）",
  "notesUrl": "https://github.com/yydye/InternalBeyond/releases/tag/v1.0.1"
}
```

> 上面是**字段全集**示例：`installer` 块与 `notes` 取自 1.0.1 的真实构建，
> `releasedAt` / `notesUrl` 只演示形状。1.0.1 实际**省略**了 `releasedAt`（§4）、
> `minimumVersion`（§8）与 `notesUrl`——省略是契约允许的，也是本次发布的事实。

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema` / `schemaVersion` | ✅ | 固定 `internalbeyond.update` / `1`。客户端不认识的版本一律当作「无更新信息」 |
| `channel` | ✅ | 目前只有 `stable` |
| `version` | ✅ | `MAJOR.MINOR.PATCH`，来自 `VERSION` |
| `installer.url` | ✅ | **完整、版本固定**的下载地址。由构建期唯一构造，客户端只校验不拼装 |
| `installer.sha256` | ✅ | 64 位小写十六进制；**直接测自本次构建产出的 exe**，不重新输入 |
| `installer.sizeBytes` | ✅ | 实测字节数；另有合理区间闸门（见 §5） |
| `installer.productVersion` | ✅ | 从 exe 的 PE `ProductVersion` 读回，必须等于 `version` |
| `releasedAt` | 可选 | ISO-8601 UTC。**只写实际发布时刻**；没有可靠来源（构建时刻不算）就省略不写，见 §4 |
| `minimumVersion` | 可选 | 目前只做形状校验，不强制。**1.0.1 刻意省略**（写 `1.0.0` 会是一句不成立的产品承诺——1.0.0 没有读取清单/更新端点的能力）；**1.0.2 起写 `1.0.1`**，那时它才第一次成为真实契约（见 §8） |
| `notes` | 可选 | 面向用户的纯文本；UI 必须以 textContent 渲染，**永不 innerHTML** |
| `notesUrl` | 可选 | 必须是 `https://github.com/...` |

未知字段：客户端**容忍并忽略**（只记 warning），这样发布端加字段不会打死旧客户端；
但构建端不允许传入未知字段（拼错字段名必须当场失败，而不是静默丢一个字段）。

---

## 4. `releasedAt` / `notes` 绝不编造

两者都**没有可靠的构建期来源**：构建可能比发布早好几天，而发布文案是人写的。
因此：

- 只有在显式传参时才写入；
- 没传就**省略字段**，构建会打印 `WARN` 明确告诉你少了什么；
- 构建脚本与 `runtime/update-manifest.js` 里**没有任何时钟**（有测试守着这条）。

代价是诚实的：省略 `releasedAt` 时客户端不显示发布日期；省略 `notes` 时更新卡片上
没有更新说明。这比显示一个编造的时间戳要好。

### `releasedAt` 只能写「实际发布时刻」，绝不写构建时刻

构建期的时钟**不是**发布时刻：一次构建可能躺在 `dist\` 里好几天才被上传（1.0.1 正是如此）。
因此：

- 能确定实际发布时刻 → 才写 `releasedAt`；
- 确定不了 → **省略字段**。构建刚结束时永远属于「确定不了」（那一刻还没发布）；
- 绝不允许把构建时间戳填进 `releasedAt`（哪怕它看起来很接近）。

### 发布前要改清单：只重生成清单，绝不重编译安装器

清单的三个实质字段（`sha256` / `sizeBytes` / `productVersion`）全部**实测自 exe 字节**，
所以针对**同一份已核验的 exe** 可以安全地只重生成清单：产出的 `installer` 块与「构建时生成的
清单」逐字节相同（已实测），而安装包字节一个都不动。

```powershell
# 只重生成清单（不重新编译安装包）。省略 --releasedAt 就是「无发布时间」清单。
node runtime\update-manifest.js --write dist\update-stable.json `
  --version 1.0.1 `
  --sha256 <实测：sha256sum dist\InternalBeyond-Setup-1.0.1.exe> `
  --sizeBytes <实测字节数> `
  --productVersion <从同一 exe 的 PE ProductVersion 读回> `
  --notesFile docs\release-notes\1.0.1.md
```

重生成后必须复核三件事：`--validate` 通过、`installer` 块与重生成前**逐字节相同**、
exe 的 sha256 与字节数**没有变**。**不要**为了改一个可选字段去重编译安装器——那会产出
另一份字节，而发布只认已核验的那一份（§6）。

---

## 5. 构建期闸门（写清单之前必须全部成立）

构建脚本第 7 步按顺序验证，任一不符即**整个构建失败**（宁可不产出，也不产出一份和
字节对不上的清单）：

1. `installer.sha256` = 第 6 步对刚编译出的 exe 实测的 SHA-256（不是重新输入的值）；
2. `installer.sizeBytes` = 该 exe 的实际文件长度；
3. `installer.productVersion` = 从该 exe 的 PE `VersionInfo.ProductVersion` 读回，
   且必须等于 `VERSION`；
4. `installer.url` 的**资产名**必须等于本次真正产出的文件名
   （ISCC 的 `OutputBaseFilename` 与 `installerAssetName()` 是两处独立拼写，
   这里用真实字节把它们钉死，否则清单会指向一个不存在的资产）；
5. 整份清单再由 `runtime/update-manifest.js` 自校验一次（schema / URL 形状 /
   hash 格式 / size 区间 / 版本一致性）；
6. 清单**不进载荷**：`dist\update-stable.json` 是发布资产，不在白名单里，
   不会被打进安装包。

`sizeBytes` 的合理区间（`8 MiB`–`512 MiB`）不是安全控制，只是防截断/防胡写的闸门：
载荷始终含内置 Node 运行时，真实安装包约 48 MB。

---

## 6. 发布阶段（人工，必须遵守）

```bash
# 1) 创建 release 并上传前两个产物（顺序 1 → 2）
gh release create v1.0.1 \
  "dist/InternalBeyond-Setup-1.0.1.exe" \
  "dist/SHA256SUMS.txt" \
  --title "InternalBeyond v1.0.1" --notes-file docs/release-notes/1.0.1.md

# 2) 复核：上传后的资产 digest 必须与清单里的 sha256 一致（见下方硬规则）

# 3) 最后上传清单（顺序 3）
gh release upload v1.0.1 "dist/update-stable.json"
```

### 硬规则：exe / `SHA256SUMS.txt` / 清单必须来自同一份已核验构建资产

这条规则**不依赖「构建是否可复现」**，它无条件成立：

- `dist\` 的三件产物必须由**同一次构建**从同一份源码产出后一起发布；
- 清单的 `sha256` / `sizeBytes` / `productVersion` 必须**实测**自那个 exe 的字节，
  绝不重新输入、绝不从别处抄；
- **不允许用重新构建的产物替代原发布字节**——即使重建恰好逐字节重现了它；
- 上传后 GitHub 给出的 asset `digest` 仍必须**独立交叉核对**（见下），
  不能因为「应该一样」就跳过。

#### 关于「构建是否可复现」：只记录实测，不做假设

本机实测（同一工作树、同参数、同工具链、连续两次构建）：

| 构建 | 字节数 | SHA-256（前 16 位） |
|---|---|---|
| 第 1 次 | 50,828,077 | `4e5dc61a3ae36460` |
| 第 2 次 | 50,828,077 | `4e5dc61a3ae36460` |

两次**逐字节相同**。原因是实测出来的：该 exe 的 PE `TimeDateStamp` = `1770810027`
（= `2026-02-11T11:40:27Z`），**不是构建时刻**（构建发生在 `2026-09-10T11:11Z`），
`CheckSum = 0`；staging 用 `fs.copyFileSync` 复制，其 mtime 不进入产出字节。
（Inno Setup 自己也是有意固定时间戳的：`ISCC.exe` 的 `TimeDateStamp` 是 `1970-01-09`。）

**历史更正**：本文件早先版本用下面这组 v1.0.0 数据论证「同一份源码两次构建必然因时间戳/压缩
产出不同字节」——**那个论证是错的**。这两行来自**不同的源码状态**，不是同一份源码的两次构建：

| 来源 | 字节数 | 差额 |
|---|---|---|
| 已发布的 `v1.0.0` asset（tag → `23c8960`） | 50,724,579 | — |
| 当时的本机 HEAD（`VERSION` 仍是 `1.0.0`，但已包含 U1–U4） | 50,788,752 | +64,173 |

64,173 字节的差额来自**源码差异**（U 系列新增的运行时模块与前端），因此这组数据
**不能**证明构建非确定性，更**不能**用来推断「重建不可能撞上同一哈希」。

同时**不得假设跨环境可复现**：fresh clone、`core.autocrlf`（本工作树除
`InternalBeyond.html` 与 `installer\InternalBeyond.iss` 外都是 LF）、工具链版本、
ISCC 版本都会改变产出字节。因此下面三条没有商量余地：

- 发布只认**已核验的那一份**构建资产；
- 想改清单（补/去 `releasedAt` 等）只能**只重生成清单**（§4），绝不重编译安装器；
- 「反正能重建出来」永远不是替换或合并两次构建产物的理由。

因此：**清单只能和它在同一次构建里产出的那个 exe 一起发布。** 把一份本地重建的清单
挂到已有的旧 tag 上，等于向客户端宣布一个与已发布资产不符的 hash——客户端会（正确地）
拒绝安装，或者更糟：hash 校验通过但装的是别的字节（当旧资产恰好被替换时）。

发布前的最小复核（GitHub Release 页面 / API 都会显示 asset 的 `digest`）：

```
manifest.installer.sha256  ==  已上传 exe asset 的 digest(sha256)
manifest.installer.url     ==  该 asset 的下载地址
manifest.version           ==  tag 去掉 v 前缀
```

三条中任何一条不成立：**删掉 release 重来**，不要就地改清单。

---

## 7. 安全边界（必须与代码一起演进，不得淡化）

- **安装包未代码签名**（`tests/test_installer.js` 明确锁定「不引入 SignTool」）。
  因此 SHA-256 **只能证明「下载到的字节 == 清单描述的字节」**，
  **不能证明发布者身份**，也无法抵御仓库/账号被攻陷。
  **任何文档、UI 文案、错误提示都不允许把 SHA-256 描述成「验证发布者」或「已签名」。**
- 清单里的一切都是**数据**。客户端不得从中拼接命令行、不得把任何字段交给 shell；
  固定参数数组 + `shell:false` 是 U3 的红线。
- 传输必须 HTTPS；`installer.url` 的 host 只允许 `github.com`（清单层校验），
  跳转落点（`objects.githubusercontent.com` / `release-assets.githubusercontent.com`）
  属传输层，另行校验。
- 不做自修改 JS 热更新：前端零构建（D5），正式更新只走受控安装器。

---

## 8. 分发可达性的实测记录（诚实提示）

同一台机器（中国大陆网络）**两次**实测，结果不同——所以它记录的是「某时刻的观测」，
而不是「网络的稳定属性」。

**U1 期（2026-09-10 上午）**

| 主机 | 结果 |
|---|---|
| `api.github.com` | ✅ 通（~0.7 s） |
| `objects.githubusercontent.com` | ✅ 通 |
| `release-assets.githubusercontent.com` | ✅ 通（API 资产端点 302 到此） |
| `github.com` | ❌ **连接超时（10 s）** |
| `raw.githubusercontent.com` | ❌ 连接超时 |
| `codeload.github.com` | ❌ 连接超时 |

**U2 期（同日稍后，重测）**

| 主机 | 结果 |
|---|---|
| `github.com` | ✅ 302（1.6 s）→ `.../releases/download/v1.0.0/...` |
| `api.github.com` | ✅ 200（0.6 s） |
| `objects.githubusercontent.com` | ✅ 299 ms（下方的 404 是「该路径不存在」，不是网络失败） |
| `release-assets.githubusercontent.com` | ✅ 299 ms（同上） |
| `raw.githubusercontent.com` | ✅ 200（0.7 s） |
| `codeload.github.com` | ✅ 200（0.6 s） |

**结论**：该网络对 `github.com` 是**间歇性**可达，而非稳定阻断。因此

1. **primary 仍然是 primary**：常规路径直接给出结果、零 API 限额，不因为偶发阻断就常驻走 API；
2. **回退必须存在，且必须廉价**：只在 primary 连一个完整响应实体都拿不到时才启用（U-D1 Revised）；
3. 更新检查**绝不能进入 launcher 启动关键路径**，一切网络失败必须 fail-open。

### 当前 Stable 通道的实际状态（U2 实测，重要）

> ⚠️ 本节记录的是 **U2 期（v1.0.0 时代）**的观测：那时**没有任何 release 带清单**。
> **v1.0.1 发布之后**的当前状态见下一节的「发布后实测」。

已发布的 `v1.0.0` release 只有两个资产：

| 资产 | 大小 | API `digest` |
|---|---|---|
| `InternalBeyond-Setup-1.0.0.exe` | 50,724,579 B | `sha256:5f7353b8f787f8147d1fba937e155e0ef34de7aef5e73d369c821013b6f3b7e0` |
| `SHA256SUMS.txt` | 406 B | `sha256:b8ffd16f…` |

**没有 `update-stable.json`**（该 release 早于 U1 的清单能力；`digest` 与 U1 记录一致，
说明 exe 未变）。因此今天 primary 返回 **404**，而 API 回退也找不到该资产，
客户端如实报告 `no-information`（「暂时无法检查更新」），**不会**谎报「已是最新」。

这是对「hard failure 不回退」的**实测验证**：primary 的 404 是一个**响应**，所以客户端
**没有**改走 API——走 API 也只会再失败一次，纯属浪费限额。API 回退路径本身也在 U2 用
「primary 注入网络失败 + API 真实请求」跑通过：API 返回真实 v1.0.0 数据，`selectManifestAsset()`
以 `release has no asset named update-stable.json` 正确拒绝。

**要让自动更新真正生效，必须先发布一个带 `update-stable.json` 的 release**（顺序见 §2）。
在此之前 U2 的可观测结果只有 `no-information`——这是设计正确的失败姿势，不是缺陷。
同一件事对 U3 也成立：没有清单就没有「已发布的更新」，`POST /__update/start` 会以
`no-verified-manifest` 拒绝，而不是去猜一个能装的东西。

API 匿名限额实测：`x-ratelimit-remaining: 57/60`（60 次/小时/IP）。回退只在 primary 网络
失败时消耗它，且**不做重试**（U-D1 Revised 第 7 条）。

### 版本语义与 1.0.1 发布（U5-1 冻结，重要）

已发布的 `v1.0.0`（tag → `23c8960`）**早于全部 U 系列**，因此那个安装包里没有清单、没有检查、
没有下载器、没有更新界面，服务端也没有任何 `/__update*` 端点。**它的用户无法自动升级**——
这是产品事实，不是缺陷，必须靠手动安装一次跨过去。

| 版本 | 定义 |
|---|---|
| `v1.0.0` | legacy release：不包含 Zero-Touch Update，用户**必须手动安装一次 1.0.1** |
| `v1.0.1` | **第一个正式包含 Zero-Touch Update 的 release**；此后作为真实 E2E 的 baseline |
| `v1.0.2` | **第一个由真实自动更新链到达的 release**；E2E 验证 `1.0.1 → 1.0.2` |

由此产生四条硬约束：

1. **不构造、不使用任何未发布的「1.0.0 updater seed」。** E2E 的 baseline 必须是 GitHub 上的
   **真实已发布资产**（重新下载 + 核对 digest），不能是本地 `dist/` 里的重建产物。
2. **`minimumVersion` 在 1.0.1 省略，在 1.0.2 写 `1.0.1`。** 在 1.0.1 上写 `1.0.0` 等于向一个
   根本没有能力读它的版本许下承诺。
3. **tag 必须指向包含 U1–U4 的提交。** `master` 在发布前领先 `origin/master`
   （U1–U4 + 文档提交），因此**先 push、后 tag**；绝不让 `gh` 用默认
   `target_commitish`（那会指向尚未包含 U 系列的远端 `d6d52a6`）。
4. **最终清单省略 `releasedAt`。** 构建可能比发布早很久，把构建时间戳当成发布时间就是
   编造（§4）。1.0.1 的最终清单里**没有** `releasedAt`——若将来要写，只能写**实际发布时刻**，
   且只能用「只重生成清单」的方式补（§4），不许重编译安装包。

发布顺序仍是 §2 的契约（exe → SHA256SUMS.txt → **update-stable.json LAST**）：
**上传清单的那一刻，1.0.1 才第一次出现在 Stable 通道上**；在此之前客户端的诚实答案是
`no-information`（「暂时无法检查更新」），不会谎报「已是最新」。若发布后需要紧急关闭通道，
删掉 release 上的 `update-stable.json` 资产即可（primary 404 → API 回退也找不到该资产）；
但要诚实说明：**已经在下载中的客户端不会被远程叫停**。

用户可见的升级说明在 [release-notes/1.0.1.md](release-notes/1.0.1.md)，同时它就是清单 `notes`
的来源。README 也随包发行，1.0.0 用户唯一能读到的升级指引就在那里（`README.md`「升级到新版本」）。

### 发布后实测（v1.0.1 已上线，真机联网）

`v1.0.1` 已按 §2 顺序发布（tag → **`8311942`** = 发布时 HEAD、非 draft / 非 prerelease），
release 上的三个资产与 `manifest.installer.sha256` 逐项交叉核对通过：

| 资产 | 大小 | GitHub `digest` |
|---|---|---|
| `InternalBeyond-Setup-1.0.1.exe` | 50,828,077 B | `sha256:4e5dc61a…90d7` ✅ == 清单 |
| `SHA256SUMS.txt` | 406 B | `sha256:c53d29bc…6e38` |
| `update-stable.json` | 1,883 B | `sha256:a3ef3b27…5e90`（在线回读与本地 `cmp` **逐字节相同**） |

真实客户端路径实测（只读：不下载、不安装、不写缓存）：

| 运行版本 | 结果 | 传输 |
|---|---|---|
| `1.0.0` | `update-available` → `1.0.1`，读到的 `sha256`/`sizeBytes` 与上表一致、`notes` 605 字符 | `direct` **connect-timeout 8 s**（本机 github.com 此刻不可达，与 §8 描述一致）→ `api` 200 |
| `1.0.1` | `up-to-date` | 同上 |

**结论**：Stable 通道已真实生效；回退门（U-D1 Revised）也在真实数据上被验证——primary 是
**网络失败**（无完整响应实体），故恰好换路一次，成功即止。§8 上一节描述的
`no-information` 状态**自本次发布起不再成立**。

---

## 9. 相关测试

| 测试 | 覆盖 | 是否联网 |
|---|---|---|
| `node tests/test_update_manifest.js` | 契约本身：schema、唯一 URL 构造、客户端校验/解析、拒绝清单、绝不编造时间戳、无执行面 | 否 |
| `node tests/test_installer.js` | 构建脚本接线（BOM、清单步骤在 hash 之后、资产名与真实文件绑定、preflight 校验可选入参） | 否 |
| `node tests/test_update_check.js` | U2 检查运行时：回退门、唯一 semver 比较、24h 缓存、fail-open、端点契约 | 否 |
| `node tests/test_update_install.js` | U3 安装运行时：载荷回退门（U-D6）、四道校验、绝不进 `{app}`、spawn 契约与 helper 退出、状态文件、端点拒绝矩阵 | 否（载荷传输全部注入，**不构建也不运行安装包**） |
| `node tests/test_pe_version.js` | 安装包 PE 版本资源读取（真实 node.exe + 合成 PE32/PE32+ + 具名损坏） | 否 |
| `node tests/test_installer_build.js --force` | **真实构建**：清单由真实 exe 的 hash/size/PE 版本产出且自校验通过、清单不进载荷 | 否（本地编译，不安装） |

真实构建回归默认不跑（需要 Inno Setup 6，约 35 s），见
[P7-TEST-BUDGET.md](P7-TEST-BUDGET.md)。
