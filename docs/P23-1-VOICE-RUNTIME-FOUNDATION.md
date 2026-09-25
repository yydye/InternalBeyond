# P23 Phase 1 · Voice Runtime Foundation

**Status:** implemented · 2026-09 · scope = Voice API Source + Voicebox Local Provider + Native Voice Message 基础契约
**Non-goals (P23 Phase 2):** Human-like Delivery Planner、按句自动拆消息、一轮多发、text→voice→image 消息序列、typing/pause、群聊与主动消息的语音行为重构、Voicebox personality/rewrite、Voicebox 安装器 / 模型下载器。

---

## 1. Phase 0 审计结论（全部 file:line 取自改动前的实现）

### 1.1 当前 Voice 架构

```text
角色 Voice 配置（apiConfigs[].voice，IndexedDB）
  enabled / provider / voiceId / rate / pitch / autoPlay
  model / language / style / voiceType / voiceData           ← 无 endpoint、无 apiKey
        │
        │  渲染后由 MutationObserver 挂 Voice 按钮 / 按 autoPlay 入队
        ▼
assets/js/bridge.js  _ibTtsPayload()   ← 唯一 wire payload 组装点
        │  POST /api/tts
        ▼
bridge/routes.js  /api/tts
        │
        ▼
bridge/tts.js  normalizeVoiceProfile() → ttsSynthesize() → TTS_PROVIDER_REGISTRY[provider].synthesize
        │
        ├── edge     → 微软 Edge readaloud WebSocket（endpoint 硬编码在协议里）
        ├── openai   → config.json → tts.endpoint / tts.apiKey
        └── mimo     → config.json → ttsMimo.endpoint / ttsMimo.apiKey
        │
        ▼
saveTtsAudio() → DATA_DIR/tts_<uid>.mp3 → /tts/<id>.mp3
        │
        ▼
浏览器 new Audio(url) 播放（**仅运行时**：URL 不进消息记录）
```

### 1.2 Storage authority

| 数据 | 存储 | 证据 |
|---|---|---|
| 角色 Voice 配置 | IndexedDB `apiConfigs[].voice` | `assets/js/social.js:1339-1362`（保存）、`:1288-1305`（加载） |
| 角色 LLM 凭据（与 Voice 无关） | IndexedDB `apiConfigs[].apiKey` | `assets/js/social.js:710-729` |
| TTS 凭据（OpenAI 兼容） | Bridge `config.json` → `tts` | `bridge/config.js:32-39` |
| TTS 凭据（MiMo） | Bridge `config.json` → `ttsMimo` | `bridge/config.js:40-45` |
| TTS 试听/生产音频 | Bridge `DATA_DIR/tts_<uid>.mp3` | `bridge/tts.js` `saveTtsAudio` |
| 语音转写凭据 | IndexedDB `apiSettings.voiceTrans`（浏览器直连上游） | `assets/js/communication/voice.js:43-54` |
| 消息 | IndexedDB `chatMessages`（M1-A 起 canonical 可在 Home Node） | `assets/js/core.js:3-4`、`home-node-bootstrap.js:207-256` |

结论：**角色记录里从来没有、也从来不需要 apiKey**；TTS 凭据的权威只有 Bridge `config.json`。
`provider` 事实上就是来源选择，只是没有名字、没有目录、也无法表达「本地运行时」。

### 1.3 Runtime call graph（assistant 文本 → 语音）

| # | 位置 | 说明 |
|---|---|---|
| 1 | `assets/js/communication.js:2444` / `:2930` | 生成 `aiMsg` 并 `dbPut('chatMessages', aiMsg)` —— **只有文本，没有 voice** |
| 2 | `assets/js/bridge.js:163-182` | `ibObserve()` 用 MutationObserver 监听 `chat-full-messages` / `chat-messages`，对新节点调 `ibAttachTts` |
| 3 | `assets/js/bridge.js:752-775` | `ibAttachTts` 读 `_ibGetCharVoice(bubble)`；`vc.enabled` 才挂 Voice 按钮；`vc.autoPlay` 则 1200ms 后 `_ibTtsEnqueue` |
| 4 | `assets/js/bridge.js:798-848` | `ibTtsSpeak` / `_ibTtsSpeakImpl` → `_ibTtsPayload` → `POST /api/tts` |
| 5 | `bridge/routes.js:732-739` | `ttsSynthesize(ttsNormalize(body))`，失败 503 |
| 6 | `bridge/tts.js` | provider adapter → `saveTtsAudio` → `{ok,id,url,bytes}` |
| 7 | `assets/js/bridge.js:850-895` | `_ibTtsPlayQ` / `ibTtsBar`：**只更新 DOM**，把按钮换成播放条 |

**结论（问题 B 的根因）**：第 7 步之后什么都没写回数据库。语音是「文本消息的运行时播放附件」，
不是消息类型 —— reload 后播放条消失（`bubble.dataset.ibTtsUrl` 只是内存字段）。

### 1.4 TTS provider / executor 穷举（源码实证，不按 UI 文案）

| provider | executor | 能力 | 凭据来源 |
|---|---|---|---|
| `edge` | `edgeTtsGen`（WS/RFC6455） | builtin + prosody | 无（协议内 TrustedClientToken） |
| `openai` | `openaiSynthesize` | builtin + style + model | `config.tts` |
| `mimo` | `mimoSynthesize` / `mimoCloneSynthesize` / `mimoDesignSynthesize` | builtin + clone + design + style | `config.ttsMimo` |

只有这三个。`TTS_PROVIDER_REGISTRY` 是唯一注册表（`bridge/tts.js`）。

### 1.5 消息 canonical 表示

`docs/CHAT_MESSAGE_CONTRACT.md` §2 与 `assets/js/chat-core.js:52-56`：
`voice` **已经是** canonical 条件字段，且 `validateMessage` 要求它是 object。既有形状
（只有用户录音写入）：`{dataUrl, mime, duration, transcript, tone}`（`communication.js:2110`、`:2498`）。
assistant 消息从来不写 `voice`。渲染分支只对 `role==='user'` 生效
（`communication.js:455`、`:463`、`:484`）。

### 1.6 IndexedDB schema / migration

- `InternalBeyondDB` v24，`chatMessages` keyPath `id`，唯一索引 `byFriend`（`core.js:3-4`）。
- 无需升级：`voice` 已是 canonical 字段，本轮是**纯字段级**扩展，**DB 版本保持 24**，旧数据零迁移。
- 既有迁移套件 `tests/test_chat_migration.js` 继续作为回归证据。

### 1.7 与既有契约不冲突的结论

`voice`（一级消息）、`source`（来源引用）、`provider`（wire 字段）三者都不与任何既有字段或
行为冲突；Phase 1 与用户给定的边界**无实质冲突**，因此继续实施。

---

## 2. 最终架构

```text
角色 Voice 配置（apiConfigs[].voice）
  enabled / source / provider / mode(model) / voiceId(profile) / voiceType / voiceData
  rate / pitch / style / language / autoPlay        ← 只保存**引用**，不保存任何凭据
        │
        │  IB 是「说什么」的 authority：文本原样下行，绝不请求改写
        ▼
assets/js/bridge.js  _ibTtsPayload()（唯一 wire payload 组装点，带 source）
        │  POST /api/tts
        ▼
bridge/routes.js  /api/tts    /api/tts/sources    /api/tts/voicebox/{health,profiles}
        ▼
bridge/tts.js  normalizeVoiceProfile(source→provider) → ttsSynthesize → Registry
        │
        ├── edge     ──────────────────────────────► Microsoft Edge readaloud
        ├── openai   ──────────────────────────────► config.tts.endpoint
        ├── mimo     ──────────────────────────────► config.ttsMimo.endpoint
        └── voicebox ─► bridge/voicebox.js ────────► 本地 Voicebox REST (/generate → /history → /audio)
                                                        （独立进程；IB 不启动、不安装、不嵌入）
        ▼
saveTtsAudio(buf,{ext,mime,duration,engine}) → DATA_DIR/tts_<uid>.{mp3|wav} → /tts/<id>.<ext>
        ▼
assets/js/voice-message-core.js  build()  ← 唯一 voice message 构造/清洗/播放源解析
        ▼
chatMessages[].voice = { dataUrl|audioUrl, mime, duration, transcript, provenance{…} }
        ▼
assets/js/communication.js  _ibAiVoicePayload → _renderAiVoice → voice 气泡（文字稿按需展开）
```

---

## 3. Canonical Voice API Source authority

| 概念 | 定义位置 | 说明 |
|---|---|---|
| source id | `bridge/tts.js` `TTS_PROVIDER_REGISTRY[*].source` | `edge` / `tts` / `ttsMimo` / `voicebox` |
| source→provider 映射 | `bridge/tts.js` `TTS_SOURCE_TO_PROVIDER` | **唯一一份**，大小写不敏感 |
| 来源目录（UI 用） | `GET /api/tts/sources` → `tts.listVoiceSources()` | 只含 id/label/能力/`credential` 说明/`configured`，**不含 endpoint / apiKey** |
| 凭据 | Bridge `config.json` → `tts` / `ttsMimo` / `voicebox` | 角色记录与浏览器都拿不到 |
| 兼容解析 | `normalizeVoiceProfileCore` | 有 `provider` → 用 provider；否则用 `source`；都没有 → 历史缺省规则（配好 tts 则 openai 否则 edge） |

角色保存的唯一新字段是 `voice.source`（引用）。历史数据没有它，输出时按 provider 反推，
因此旧配置不失效、不需要批量改写。

---

## 4. Voicebox REST contract 与 adapter 映射

上游证据（`github.com/jamiepine/voicebox`，main 分支）：

| 项 | 上游实际 | 证据 |
|---|---|---|
| 默认地址 | `http://127.0.0.1:17493` | README API 示例 + `backend/app.py` 默认 CORS 白名单 |
| 生成 | `POST /generate` JSON | `backend/routes/generations.py` `generate_speech` |
| 请求体 | `{profile_id, text, language?, seed?, model_size?, instruct?, engine?, personality, max_chunk_chars, crossfade_ms, normalize, effects_chain}` | `backend/models.py` `GenerationRequest` |
| engine enum | `qwen\|qwen_custom_voice\|luxtts\|chatterbox\|chatterbox_turbo\|tada\|kokoro` | `backend/models.py` pattern |
| language enum | 23 项（zh/en/ja/ko/…/sw/tr） | `backend/models.py` pattern |
| 同步性 | **异步**：`/generate` 立即返回 `GenerationResponse{id,status:'generating'}`，队列串行 | README「Async Generation Queue」+ `services/task_queue.py` |
| 状态 | `GET /history/{id}` → `{status: loading_model\|generating\|completed\|failed, duration, audio_path, error, engine}` | `backend/routes/history.py` |
| 状态流（SSE） | `GET /generate/{id}/status` → `text/event-stream` | `backend/routes/generations.py` |
| 音频 | `GET /audio/{id}` → 文件字节，`Content-Type` 由扩展名推导 | `backend/routes/audio.py` |
| profile 列表 | `GET /profiles` → `VoiceProfileResponse[]` | README + `backend/routes/profiles.py` |
| 健康 | `GET /health` → `{status, model_loaded, gpu_available, gpu_type,…}` | `backend/routes/health.py` |
| 鉴权 | 无（本地服务）；`/speak` 才用 `X-Voicebox-Client-Id` 做绑定 | `backend/routes/speak.py` |
| personality/rewrite | `personality: bool`，默认 false；true 时才经本地 LLM 改写 | `backend/models.py`、`generations.py` `personality.rewrite_as_profile` |

IB 侧映射（`bridge/voicebox.js`，唯一映射点）：

| IB（normalize 输出） | Voicebox | 说明 |
|---|---|---|
| `text` | `text` | 逐字下行；**IB 是「说什么」的 authority** |
| `voice.id` | `profile_id` | 先按 id 再按 name（大小写不敏感）解析，与上游 `/speak` 同优先级 |
| `model` | `engine` | 留空则不发送，由 profile 的 `default_engine` 决定（IB 不猜上游默认） |
| `language` | `language` | 不在上游 enum 内则不发送 |
| `style` | `instruct` | 交付/语气指令，上限 500（上游 `max_length=500`） |
| `rate` / `pitch` | — | 上游无 prosody 参数，`capabilities.prosody=false` 已在上游被过滤 |
| （恒置） | `personality: false` | **硬编码**：永不启用 Voicebox 的改写通道 |

轮询/超时/失败分类：`bridge/voicebox.js` `waitForGeneration`（400ms 间隔 / 180s 上限）、
`requestJson`（15s）、`health`（2.5s）、`fetchAudio`（30s）。全部以 `{ok:false,error}` 返回，**绝不 throw、绝不静默 fallback**。

---

## 5. Native Voice Message schema

`chatMessages[].voice`（assistant）：

```json
{
  "dataUrl": "data:audio/wav;base64,……",
  "audioUrl": "/tts/tts_xxx.wav",
  "mime": "audio/wav",
  "duration": 2.5,
  "transcript": "今晚早点睡。",
  "provenance": {
    "source": "voicebox", "provider": "voicebox", "engine": "qwen",
    "model": "", "voiceId": "prof-uuid-1", "voiceType": "builtin", "refAudioId": ""
  }
}
```

规则（`assets/js/voice-message-core.js`，Node 与浏览器共用同一份）：

1. `dataUrl` 与 `audioUrl` **至少一个**，否则 `build()` 返回 `null` —— 不写假 voice message。
2. 内联音频超过 `INLINE_MAX_BYTES`（2 MB 原始字节）时不内联，只保留 `audioUrl`
   （两种形态 reload 后都可播放，都**不依赖运行时 object URL**）。
3. `provenance` 只允许白名单键，且任何层级出现 apiKey/token/secret/authorization/password
   或 `Bearer …` / `sk-…` 形态的值一律丢弃。
4. 用户录音消息（`{dataUrl,mime,duration,transcript,tone}`）形状**不变**，也不走本构造器。
5. `content` 保持不变 —— transcript 是 voice 自己的数据，不是第二条 text message。

---

## 6. Migration / compatibility 策略

| 风险 | 处理 | 证据 |
|---|---|---|
| 老角色 Voice 配置 | 无 `source` ⇒ 按 provider 反推；provider 语义逐字不变 | `bridge/tts.js` normalize + `tests/test_voice_source.js` A1 |
| 老消息 | `voice` 早就是 canonical 字段；**DB 版本仍是 24**，零迁移 | `tests/test_native_voice_message.js` H |
| 自动播放语义 | `autoPlay` 仍只控制「收到回复后自动生成并播放」；只是成功后**顺带**把消息升级为 voice message | `bridge.js` `ibAttachTts` 未改 |
| Edge / OpenAI / MiMo | Registry 与请求体逐字保留；`source` 不进入旧 provider 的请求体 | `tests/test_voice_source.js` A5 |
| 用户语音消息 | 渲染、播放、tone 全部逐字节保留 | `test_native_voice_message.js` D/F |
| 上下文/记忆/摘要 | assistant voice message 的 `content` 就是文字稿；历史映射与 `getTextContent` 增加 `role==='user'` 守卫，**防止 assistant 侧重复注入** | `communication.js:1317`、`:2581` |
| 撤回消息 | `withdrawn` 一律回落为文本，不画可播放气泡 | `_ibAiVoicePayload` |
| 富文本/续写/贴纸消息 | 落库后就地换气泡有守卫；有 button/img/既有气泡时不替换 | `bridge.js` `_ibSwapLiveVoiceBubble` |
| Voicebox offline | 只影响选了这个来源的角色；`/api/tts` 返回可读错误，不回落别的 provider，不影响文字聊天 | `tests/test_voicebox_provider.js` J |

---

## 7. 修改文件清单

| 文件 | 职责 |
|---|---|
| `bridge/voicebox.js` **(新)** | Voicebox 适配器：endpoint 唯一权威、profile 解析、`/generate`→`/history`→`/audio`、错误分类、`personality:false` 硬约束 |
| `bridge/config.js` | 新增 `voicebox` 默认段（enabled + endpoint）并纳入配置自愈清单 |
| `bridge/tts.js` | 注册 `voicebox` provider；`source` 字段 + `TTS_SOURCE_TO_PROVIDER`；`listVoiceSources()`；`saveTtsAudio` 支持 wav |
| `bridge/routes.js` | `GET /api/tts/sources`、`GET /api/tts/voicebox/{health,profiles}`；`/tts/<name>` 接受 `.wav` 并按真实类型标注 |
| `services/ib-bridge-service.js` | 组合根：创建 `createVoicebox` 并注入 `createTts`，暴露给路由层 |
| `assets/js/voice-message-core.js` **(新)** | Native Voice Message canonical 契约（纯函数、UMD 双加载） |
| `assets/js/bridge.js` | payload 带 `source`；合成成功后就地升级为 voice message；`_ibFetchAiVoiceDataUrl`/`_ibProbeAudioDuration`/`_ibPersistAiVoice`/`_ibSwapLiveVoiceBubble` |
| `assets/js/social.js` | Voice 卡片的来源目录（`loadVoiceSourceCatalog`）、来源提示、Voicebox profile 下拉、保存 `voice.source` |
| `assets/js/communication.js` | assistant voice message 渲染分支（两种布局）；`getTextContent` / 历史映射的 `role==='user'` 守卫 |
| `assets/js/communication/voice.js` | `_buildVoiceEl(v,opts)` 支持文字稿开关与不可播放态；`_vmSrcOf` 统一播放源 |
| `assets/css/core/chat.css` | voice 气泡的文字稿开关 / 容器 / 不可播放态 / 来源提示样式 |
| `InternalBeyond.html` | 加载 `voice-message-core.js`；来源提示元素；Enable Voice 说明文案 |
| `tests/test_voicebox_provider.js` **(新)** | Voicebox 适配器 contract / 错误分类 / Bridge 集成（offline 不扩散） |
| `tests/test_voice_source.js` **(新)** | Legacy 不回归 / source 解析 / endpoint 权威 / credential 边界 |
| `tests/test_native_voice_message.js` **(新)** | create / persist / hydrate / render / play / duration / transcript / provenance / 失败与兼容 |
| `tests/test-all.js` | 登记上述三个套件（static 2 + service 1） |

---

## 8. 已知限制

1. **内联音频上限 2 MB**：超长回复的语音只保留 Bridge 引用（`audioUrl`），跨机器导出后不可播放
   （与既有图片内联策略同一权衡）。
2. **WAV 体积**：Voicebox 输出 WAV（上游 `GenerationRequest` 无 `format` 参数），
   因此长回复更容易落到「引用」形态而非内联。
3. **live 气泡替换有守卫**：带贴纸/点歌/工具卡/图片或续写药丸的消息，本轮不就地替换，
   要等下一次渲染（reload / 重开对话）才显示为气泡。
4. **异步轮询**：Voicebox 生成是队列式，IB 侧以 400ms 轮询 `/history` 收口；
   首次加载模型可能较慢（上限 180s）。
5. **不做打断/续播**：单实例播放策略沿用既有全局 `_vmAudio`，不实现 barge-in（属于 Phase 2 范畴）。
6. **未做 Voicebox 的真实连通性验收**：本机没有安装 Voicebox 运行时，
   全部通过 mock 上游 + 真实 Bridge 子进程验证 contract 与失败语义。

---

## 9. 下一阶段（P23 Phase 2）建议边界

- 在**不新建存储**的前提下扩展 `voice` 记录以承载多消息序列：`message.sequence` 或轮次级 planner 输出，
  仍以 `chat-core.js` 的 canonical 字段白名单为准。
- Delivery Planner 只能决定「发几条、每条什么形态」，**不得改写** IB 已生成文本。
- 打断/续播、句级流式（`streamSynthesize` 已存在，Phase 2 才接 UI）。
- Voicebox `engine` 选择器从「可选项清单」升级为「按 profile 可用 engine 过滤」（需要上游新增端点）。
