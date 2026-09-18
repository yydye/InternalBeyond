# Image Router 架构

**Status: Canonical**
**Scope: 当前 Image Router / 图片生成 / 图片编辑的路由架构**

> 本文描述 InternalBeyond 当前真实的 Image Router runtime。取信顺序：生产代码 → targeted 测试 →
> 既有 contracts → D11 审计 → 历史文档。若冲突，以代码为准。

---

## 1. 定义

Image Router 是图片请求的**路由决策层**：它回答“这次图片请求走哪个 provider / 哪个模型 / 哪把凭据”，
但**不执行**生成、**不拥有** provider、**不保存**结果。

```text
Route Decision ≠ Provider Authority ≠ Credential Authority ≠ Image Execution ≠ Image Storage
```

## 2. 系统位置

| 模块 | 职责 |
| --- | --- |
| `assets/js/image-router.js` | 顶层入口 `IB.imageRouter.routeImageRequest`（薄决策层） |
| `assets/js/image-router-core.js` | 路由算法 / 模式识别 / 打分 / 排序（唯一实现，无 DOM/IO） |
| `assets/js/image-router-config.js` | 路由配置解析与绑定（Settings → Image Router） |
| `assets/js/image-models-core.js` | 图片模型目录（唯一元数据来源） |
| `assets/js/image-edit-core.js` / `image-edit.js` | 图片编辑核心与 UI |
| `assets/js/workspace.js` | **唯一 provider 执行器** `_wsExecImageGen`；`_imgResolveProvider` |

## 3. Runtime Flow

```text
Chat / Moments / AI Moments / 等
        ↓
IB.imageRouter.routeImageRequest          （image-router.js）
        ↓ 读取路由配置 + 模型目录
route decision → API 配置 + 模型           （image-router-config / image-models-core）
        ↓
executor window._wsExecImageGen           （workspace.js，唯一 provider 执行点）
        ↓
Provider API → 图片生成 / 编辑 → 图片存储 / UI
```

## 4. 路由决策

- 路由配置存于 `apiSettings` 私有 key `image_router`（provider/model/凭据 + routes）。
- 用户档位来自 Middle Brain：`middleBrainImageMode()`（`fast / auto / precision`），默认
  `CORE.IMAGE_MODE_DEFAULT`。
- `routeImageRequest` 在 core 未加载或 executor 缺失时**一律返回 `{ok:false,…}`**，并默认落入
  Scheduler 路径（不会静默伪造成功）。
- 角色图片配置以 `cfg.imageGen` / `imageGenModel` / `imageGenProvider` 表达；
  `image-router-config.js` 负责把路由结果绑定回角色配置。端点/密钥解析回退到
  `imageGenEndpoint || endpoint`、`imageGenApiKey || apiKey`。

## 5. Image Edit 边界

- 编辑由 `image-edit-core.js` 表达，走 Provider 的 `/images/edits` 路径（`image-models-core.js` 标注）；
  与生成共用同一 executor（`_wsExecImageGen`）与同一 provider 解析（`_imgResolveProvider`）。
- Router 不拥有编辑执行；它只决定编辑请求的 route。

## 6. 相关 Boundary

- **Provider**：provider 执行在 `workspace.js`（`_wsExecImageGen`），Router 只做决策；无 “Image Router provider
  authority”。
- **Credential**：凭据来自路由配置 / 角色配置，Router 不创建也不拥有凭据权威（沿用既有 endpoint/apiKey 解析）。
- **Middle Brain**：MB 提供图片档位决策（`middleBrainImageMode`），Router 消费该决策；MB 不执行图片。
- **Moments**：`wantImage` 只是模型建议；真正的图片生成由浏览器 Image Router / executor 在 ingest 时执行。
- **Storage**：生成结果不进入 Image Router；保存/展示属于调用方与图片存储。

## 7. UI Boundary

Settings → Image Router 面板（`image-router-settings.js`）是配置 surface，不是 authority。

## 8. Non-goals

Image Router 不拥有：provider authority、credential authority、图片生成/编辑执行、图片存储、模型目录之外的模型来源。

## 9. Enforcement

| 关注点 | 测试 |
| --- | --- |
| 路由决策 / 配置 | image-router 相关 targeted 测试（`tests/` 内 image* 测试） |
| 编辑 | `tests/` 内 image-edit 相关测试 |

## 10. Historical References

`assets/js/image-router*.js` / `image-models-core.js` / `image-edit*.js` 头部设计注释（P12 / P13 / P15 / A1.5）。
