# P2 · Video Runtime 设计定稿

> 记录在现有 Audio Call Runtime 之上建立**独立、可复用 Video Runtime** 的最终边界与 Stage 1 实施清单。
> 本文档只描述设计意图与接口契约；**本阶段不改生产代码**。P2 明确**不做**：Gift / 留影 / 双语字幕 / Summary / Memory。

---

## 0. 三层职责边界（关键设计）

视频能力被**切成三层**，各司其职，互相不侵占：

| 层 | 归属 | 职责 | 不负责 |
|---|---|---|---|
| **Video Runtime** | 新模块 `assets/js/communication/video-runtime.js`（UMD） | `Camera → MediaStream → <video> 预览 → Frame Capture → Compression`；输出**原始帧** `{dataUrl,width,height,timestamp}` | 不生成 visionReference、不做模型路由、不持久化、不碰 LLM |
| **Communication Runtime** | `communication.js`（既有） | `Frame → _ibModelCanSee → native image parts / 本地 Qwen _describeImagesLocally → request-local LLM 注入`（复用 P1 request-local 缝） | 不做相机/视频捕获 |
| **Call Runtime** | `call.js :: VoiceCall`（既有） | 生命周期、turn、UI 编排——组合 Video Runtime 实例进通话弹窗，把帧交给 Communication Runtime | 不实现视觉捕获/路由细节 |

> 硬约束：Video Runtime **不**重复实现 `compressImage`（复用 communication.js 既有），**不**复制 Voice Runtime，**不**把视频逻辑塞进 Voice Runtime，**不**新建第二套视觉 capability 判定。

## 1. 数据流（三层协作）

```
[Video Runtime]
Camera → getUserMedia({video}) → MediaStream
   ↓
<divideo>.play() 自预览
   ↓ (定时/手动)
canvas.drawImage(videoFrame) → toBlob → 复用 compressImage → JPEG
   ↓
输出原始帧 {dataUrl,width,height,timestamp}
   ↓
[Communication Runtime]
_ibModelCanSee(cfg)?
   ├─ 原生视觉 → 帧作 image parts
   └─ DeepSeek 文本 + 本地视觉 → _describeImagesLocally → 文本
   ↓ request-local（messages 新对象，非 userMsg）
LLM
   ↓
[Call Runtime] 生命周期/turn/UI 编排（组合与释放）
```

## 2. Video Runtime 接口契约

```js
// window.IBVideoRuntime / IB.videoRuntime
createVideoRuntime({ videoHost /* DOM 元素 */ }) -> runtime

runtime.start(cameraOpts?) -> Promise<{stream, video}>
  // cameraOpts: { width?, height?, facingMode? }（可选，默认 640×480）; 
  // 成功前 getUserMedia({video}), 将 stream 挂到 videoHost <video> 的 srcObject 并 play()

runtime.captureFrame({ targetWidth?, quality? }) -> Promise<{dataUrl,width,height,timestamp}>
  // 帧捕捉：video 当前帧 → 离屏 canvas（targetWidth 限制/等比）→ toBlob('image/jpeg')
  //           → 复用 window.compressImage(blob)（既有压缩，不重造）
  // 返回原始帧对象，纯 request-local，不落任何存储

runtime.getLastFrame() -> {dataUrl,width,height,timestamp} | null   // 仅内存，不持久化
runtime.stop()      // 停预览（video.pause(), srcObject=null）
runtime.free()      // stop() + stream.getTracks().forEach(track.stop()) + 清定时器 + 若 objectURL 则 revoke

runtime.on('frame', cb)   // 可选事件，供 Call Runtime 订阅当前帧
```

**帧对象**（唯一产物，纯数据）：
```
{ dataUrl: 'data:image/jpeg;base64,...', width, height, timestamp /* Date.now() */ }
```

> **本地 Qwen 定位（重要，供后续 AI 理解）**：`_describeImagesLocally`（vision/ Qwen2.5-VL）是**「DeepSeek 还是瞎子」时期的补丁**——当时 DeepSeek 文本模型收不到图片，需先把图转成文字描述再喂它。**现在 DeepSeek 已有视觉**（`deepseek-v4-flash-vision-exp` 原生图片输入，走 `_usesNativeDeepSeekVision` 直发 image parts），**但本地 Qwen 路径保留**，作为**非原生 DeepSeek 文本模型的兜底**。它**不是 DeepSeek 的固定视觉通道**，也不是视频专属——frames 与普通图片共用这条既有路由，保留为兼容/兜底，勿删除、勿当作"视频专用转文字"模块。

## 3. Communication Runtime 的帧处理（委托）

Communication Runtime 接收来自 Video Runtime 的**原始帧**，负责（复用既有，**零新 capability**）：
- `_ibModelCanSee(cfg)`：能否看帧；
- 原生视觉 → 帧作为 image part 注入；DeepSeek 文本 → `_describeImagesLocally` 本地 Qwen 描述 → `_appendLocalVisionContext`；
- **request-local**：复用 P1 的 `messages` 末条 user 新对象注入缝，**绝不**进 `userMsg.content` / chatMessages / Memory / UI。

> 注：Communication Runtime 的这一段**不归 Video Runtime 管**——Video Runtime 只产出帧数据，路由/注入由 Communication Runtime 决定。

## 4. Call Runtime 编排（委托）

Call Runtime 只做编排：在通话 turn 编排里持有 Video Runtime 实例、把帧交给 Communication Runtime、并在 `hangup()/finish()` 时释放。**不实现捕获/路由/持久化细节。**

## 5. request-local / persistence 边界

| 项 | 生命周期 | 持久化 |
|---|---|---|
| 自动/手动抓取的帧（Video Runtime 产物 `{dataUrl,...}`） | 仅当前 turn 的内存 | **不**进 chatMessages / Memory / UI transcript |
| （后续独立设计）留影 `<ws_vsnap/>` / 相机键夹带 | —— | 留档（不在 P2，需专门 design） |

**硬约束**：除后续明确设计外，视频帧**不进 chatMessages / Memory**。

## 6. 上游素材「直接复用 / 借逻辑 / 重写 / 不搬」

| 上游素材 | 处理 |
|---|---|
| 捕捉频率 4 档（关/每轮/30s/60s）、画质 3 档 | **借逻辑**（阈值/语义），落到 Video Runtime 的 `targetWidth`/定时档位 |
| `buildWin` / `showFace` / `#ibcw` 大窗口 | **不搬**整窗口；渲染**重写**进 fork `voice-call-modal`（只借"面切换/打开视频"思路） |
| `IBCALLW.openVideo(fid)` | **借逻辑**（进入通话面），调用点重写 |
| 帧→LLM / 视觉能力门 | **重写**：改用 fork `_ibModelCanSee` + `_describeImagesLocally` 体系 |
| 礼物、弹幕、直播间布局、留影、双语字幕 | **不搬**（P2 明确排除） |

## 7. 最小 P2 MVP（目标实现范围）

1. `video-runtime.js`（UMD）：相机流 → `videoHost` 自预览 → `captureFrame()` → 复用 `compressImage` → 输出原始帧 `{dataUrl,width,height,timestamp}`。
2. 注册 `IB.videoRuntime`（window + IB 双挂载，遵循 IIFE/BOM 约定）。
3. Communication Runtime：帧 → `_ibModelCanSee` → native/本地 Qwen → request-local 注入（沿 P1 缝）。
4. **不做**：礼物、留影、双语字幕、Summary/Memory、完整直播布局。

## 8. 测试契约

| 层 | 契约 |
|---|---|
| **Node 单测** | 帧对象构建（给定 dataUrl/width/height/timestamp 成 `{...}`）；几何/尺寸钳制；确认复用 `compressImage`（不重造压缩）；标注 `data:image/jpeg`、`width/height/timestamp` 在场。纯函数部分可在 Node 测，**相机捕获本身需浏览器** |
| **结构** | `test_frontend_structure.js`：新文件 UTF-8 BOM + IIFE 首尾 + 注册 `IB.videoRuntime` + 正确加载顺序 |
| **CDP** | 用 `canvas.captureStream()` 作 mock 相机源（headless 无真摄像头）喂给 `<video>` → `captureFrame()` → 断言返回 `{dataUrl(data:image/jpeg),width,height,timestamp}`；断言帧**不在** chatMessages / Memory / UI；`free()` 后 tracks 全停 |

## 9. 推荐实施顺序

```
Stage 1  VideoRuntime 核心（相机+流+自预览+抓帧+复用compressImage+释放） + Node/结构/CDP 测试
Stage 2  接入 Call modal 视频面 + 频率/画质档位 + 视觉路由（native vs 本地 Qwen，沿 _ibModelCanSee）
Stage 3  （独立，非 P2）礼物 [gift:heart] 锚点 / 留影·夹带持久化设计
```

---

*本文档只描述设计与接口契约，不含密钥，未改动任何生产代码。实现应以「Video Runtime 只产出原始帧数据、路由与持久化归 Communication Runtime、生命周期归 Call Runtime」为不变边界。*
