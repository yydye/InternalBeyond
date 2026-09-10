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
  -ReleasedAt 2026-09-10T06:00:00Z `
  -NotesFile docs\release-notes\1.0.1.md `
  -MinimumVersion 1.0.0
```

`-ReleasedAt` / `-NotesFile` / `-MinimumVersion` 都是**可选**的，见 §4。

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
    "sizeBytes": 50788752,
    "productVersion": "1.0.1"
  },
  "releasedAt": "2026-09-10T06:00:00Z",
  "minimumVersion": "1.0.0",
  "notes": "面向普通用户的更新说明（纯文本）",
  "notesUrl": "https://github.com/yydye/InternalBeyond/releases/tag/v1.0.1"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `schema` / `schemaVersion` | ✅ | 固定 `internalbeyond.update` / `1`。客户端不认识的版本一律当作「无更新信息」 |
| `channel` | ✅ | 目前只有 `stable` |
| `version` | ✅ | `MAJOR.MINOR.PATCH`，来自 `VERSION` |
| `installer.url` | ✅ | **完整、版本固定**的下载地址。由构建期唯一构造，客户端只校验不拼装 |
| `installer.sha256` | ✅ | 64 位小写十六进制；**直接测自本次构建产出的 exe**，不重新输入 |
| `installer.sizeBytes` | ✅ | 实测字节数；另有合理区间闸门（见 §5） |
| `installer.productVersion` | ✅ | 从 exe 的 PE `ProductVersion` 读回，必须等于 `version` |
| `releasedAt` | 可选 | ISO-8601 UTC。**没有可靠构建期来源，没给就不写** |
| `minimumVersion` | 可选 | 目前只做形状校验，不强制 |
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

### 硬规则：exe 与清单必须来自同一次构建

同一份源码、同一个版本号，**两次构建产出的 exe 字节并不相同**（时间戳/压缩等因素）。
实测证据（v1.0.0）：

| 来源 | 字节数 | SHA-256（前 16 位） |
|---|---|---|
| 已发布的 Release asset | 50,724,579 | `5f7353b8f787f814` |
| 本机重新构建同一个 `VERSION` | 50,788,752 | `e46df857a7a05a6d` |

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

API 匿名限额实测：`x-ratelimit-remaining: 57/60`（60 次/小时/IP）。回退只在 primary 网络
失败时消耗它，且**不做重试**（U-D1 Revised 第 7 条）。

---

## 9. 相关测试

| 测试 | 覆盖 | 是否联网 |
|---|---|---|
| `node tests/test_update_manifest.js` | 契约本身：schema、唯一 URL 构造、客户端校验/解析、拒绝清单、绝不编造时间戳、无执行面 | 否 |
| `node tests/test_installer.js` | 构建脚本接线（BOM、清单步骤在 hash 之后、资产名与真实文件绑定、preflight 校验可选入参） | 否 |
| `node tests/test_installer_build.js --force` | **真实构建**：清单由真实 exe 的 hash/size/PE 版本产出且自校验通过、清单不进载荷 | 否（本地编译，不安装） |

真实构建回归默认不跑（需要 Inno Setup 6，约 35 s），见
[P7-TEST-BUDGET.md](P7-TEST-BUDGET.md)。
