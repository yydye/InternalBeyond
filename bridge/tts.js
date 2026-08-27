/* IB Bridge · AI Voice（TTS）：Edge 免费 / OpenAI 兼容 / MiMo 三 provider。
   从 ib-bridge-service.js 提取为工厂：config / uid / ttsDir（mp3 输出目录）经依赖注入。
   Voice Profile 基础架构（第二阶段）：Provider Registry + normalizeVoiceProfile +
   ttsSynthesize 统一入口；ttsGenerate 降级为兼容包装（旧位置参数 → 统一管线）。
   第三阶段 A：新增 MiMo（mimo-v2.5-tts）——官方 chat-completions 兼容格式，
   文本在 assistant 消息、style 指令在可选 user 消息、audio.{format,voice}。
   edgeTtsGen 的 WS/RFC6455 实现与 OpenAI 请求行为保持原逻辑逐字不变；
   默认音色与默认语言收编为常量，数值与历史硬编码一致。 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

/* ── Provider 常量：收编自原实现中的硬编码默认值（禁止改动数值） ── */
const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const EDGE_DEFAULT_LANGUAGE = 'zh-CN';
const OPENAI_DEFAULT_VOICE = 'alloy';
const OPENAI_DEFAULT_MODEL = 'tts-1';
/* MiMo 官方文档值（mimo.mi.com Speech Synthesis v2.5）：
   endpoint 为 OpenAI chat-completions 兼容端点；audio.voice 内置音色枚举，
   缺省 mimo_default；无独立 language 参数（语言由音色决定）。
   VoiceClone（第三阶段 B2）：mimo-v2.5-tts-voiceclone，audio.voice 为必填且
   必须是 data:{MIME};base64,<b64>（仅 mp3/wav 样本，Base64 编码后 ≤10 MB，
   见官方 quick-start「使用音色复刻进行语音合成」章节）。 */
const MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts';
const MIMO_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone';
const MIMO_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign';
const MIMO_DEFAULT_VOICE = 'mimo_default';
const MIMO_BUILTIN_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
/* 官方限制：reference audio Base64 编码后不超过 10 MB（字符数）。B1 上传上限（10 MB 原文件）更宽。 */
const MIMO_CLONE_MAX_B64 = 10 * 1024 * 1024;

function createTts(deps) {
  const config = deps.config;
  const uid = deps.uid;
  const ttsDir = deps.ttsDir;
  const ttsVoices = deps.ttsVoices;

  async function edgeTtsGen(text, voiceId, rate, pitch) {
    const input = String(text || '').trim().slice(0, 2000);
    if (!input) return { ok: false, error: 'text required' };
    const voice = String(voiceId || EDGE_DEFAULT_VOICE);
    const r = String(rate || '1.0').replace('%', '');
    const p = String(pitch || '+0Hz');
    const ssml = 'X-RequestId:' + uid('r') + '\r\n' +
      'Content-Type:application/ssml+xml\r\n' +
      'Path:ssml\r\n\r\n' +
      '<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xmlns:emo="http://www.w3.org/2009/10/emotionml" version="1.0" xml:lang="' + EDGE_DEFAULT_LANGUAGE + '">' +
      '<voice name="' + voice + '"><prosody rate="' + r + '" pitch="' + p + '">' + input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</prosody></voice></speak>';

    return new Promise((resolve) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { ctrl.abort(); }, 30000);
      /* 客户端 WS 帧构造：必须带 mask；长度 126/127 双分支。
         修复：原先 header[1] = 0x80 | len 单字节编码，载荷 >125 字节（SSML 必超）时帧头溢出。 */
      function wsFrame(opcode, payload) {
        const maskKey = crypto.randomBytes(4);
        const masked = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i & 3];
        let header;
        if (payload.length < 126) {
          header = Buffer.alloc(6);
          header[1] = 0x80 | payload.length;
          maskKey.copy(header, 2);
        } else if (payload.length < 65536) {
          header = Buffer.alloc(8);
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
          maskKey.copy(header, 4);
        } else {
          header = Buffer.alloc(14);
          header[1] = 0x80 | 127;
          header.writeUInt32BE(0, 2);
          header.writeUInt32BE(payload.length, 6);
          maskKey.copy(header, 10);
        }
        header[0] = 0x80 | (opcode & 0x0f);
        return Buffer.concat([header, masked]);
      }
      const s = tls.connect({ host: 'speech.platform.bing.com', port: 443, servername: 'speech.platform.bing.com', rejectUnauthorized: true }, () => {
        const key = crypto.randomBytes(16).toString('base64');
        s.write('GET /consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=' +
          crypto.randomBytes(8).toString('hex') + ' HTTP/1.1\r\n' +
          'Host: speech.platform.bing.com\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'User-Agent: okhttp/4.5.0\r\n\r\n');
      });
      let buf = Buffer.alloc(0), handshakeDone = false, finished = false;
      const audioChunks = [];
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const audio = Buffer.concat(audioChunks);
        if (audio.length === 0) { resolve({ ok: false, error: 'Edge TTS returned no audio' }); return; }
        resolve(saveTtsAudio(audio, { lang: EDGE_DEFAULT_LANGUAGE }));
      }
      s.on('data', (data) => {
        buf = Buffer.concat([buf, data]);
        if (!handshakeDone) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          if (!buf.toString().includes('101')) { clearTimeout(timer); try { s.destroy(); } catch (e) { /* 忽略 */ } resolve({ ok: false, error: 'Edge TTS handshake failed' }); return; }
          handshakeDone = true;
          buf = buf.slice(idx + 4);
          /* Send SSML as a proper masked WebSocket text frame */
          s.write(wsFrame(0x1, Buffer.from(ssml, 'utf8')));
        }
        /* 累积式帧解析。修复：原先握手完成后的 TCP data 整体被丢弃，音频帧只收到握手残留。 */
        for (;;) {
          if (buf.length < 2) break;
          const b0 = buf[0], b1 = buf[1];
          const opcode = b0 & 0x0f;
          const masked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f, off = 2;
          if (len === 126) { if (buf.length < off + 2) break; len = buf.readUInt16BE(off); off += 2; }
          else if (len === 127) { if (buf.length < off + 8) break; len = Number(buf.readBigUInt64BE(off)); off += 8; }
          let maskKey = null;
          if (masked) { if (buf.length < off + 4) break; maskKey = buf.slice(off, off + 4); off += 4; }
          if (buf.length < off + len) break;
          let payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (maskKey) {
            const out = Buffer.allocUnsafe(payload.length);
            for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
            payload = out;
          }
          if (opcode === 0x2) {
            audioChunks.push(payload);
          } else if (opcode === 0x1) {
            /* 文本帧：turn.end 表示本次合成结束，主动收尾 */
            if (payload.toString('utf8').indexOf('Path:turn.end') !== -1) {
              finish();
              try { s.end(); } catch (e) { /* 忽略 */ }
              return;
            }
          } else if (opcode === 0x8) {
            /* 服务端 close 帧：正常结束 */
            finish();
            try { s.end(); } catch (e) { /* 忽略 */ }
            return;
          }
        }
      });
      s.on('close', () => { finish(); });
      s.on('error', (e) => {
        if (!finished) { finished = true; clearTimeout(timer); }
        resolve({ ok: false, error: 'Edge TTS: ' + String(e && e.message || e).slice(0, 200) });
      });
      ctrl.signal.addEventListener('abort', () => { try { s.destroy(); } catch (e) { /* 忽略 */ } });
    });
  }

  /* 音频落盘（两类 provider 共用；写入失败返回与原实现一致的错误形态） */
  function saveTtsAudio(buf, extra) {
    const id = uid('tts');
    try { fs.writeFileSync(path.join(ttsDir, id + '.mp3'), buf); } catch (e) { return { ok: false, error: 'write failed' }; }
    return Object.assign({ ok: true, id, url: '/tts/' + id + '.mp3', bytes: buf.length }, extra || {});
  }

  /* ── provider 适配器：入参一律为 normalizeVoiceProfile 输出的统一 profile ── */

  async function edgeSynthesize(profile) {
    return edgeTtsGen(profile.text, profile.voice.id || EDGE_DEFAULT_VOICE, profile.rate, profile.pitch);
  }

  async function openaiSynthesize(profile) {
    /* OpenAI / OpenAI-compatible TTS。请求体与提取前完全一致（model/input/voice/response_format）；
       仅当用户显式填写 style（capability: style）时才附加 instructions 字段。 */
    const t = config.tts || {};
    if (!t.enabled || !t.endpoint || !t.apiKey) {
      return { ok: false, error: 'TTS not configured: edit config.json tts section (enabled/endpoint/apiKey/model/voice)' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const body = {
        model: profile.model || t.model || OPENAI_DEFAULT_MODEL,
        input: String(profile.text).slice(0, 4000),
        voice: profile.voice.id || t.voice || OPENAI_DEFAULT_VOICE,
        response_format: 'mp3'
      };
      if (profile.style) body.instructions = profile.style;
      const res = await fetch(t.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (t.apiKey || '')
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        return { ok: false, error: 'TTS failed (HTTP ' + res.status + '): ' + err.slice(0, 200) };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: 'TTS returned empty audio' };
      return saveTtsAudio(buf, { lang: t.lang || 'zh-CN' });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: 'TTS request: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  async function mimoSynthesize(profile) {
    /* MiMo TTS（chat-completions 兼容）：目标文本必须放 assistant 消息；
       style ⇒ 可选 user 消息（空则不发 user，绝不发送空 content 指令）。
       audio.format 固定 mp3（与现有 /tts/*.mp3 落盘与 Content-Type 链路一致）。
       错误分类：未配置=配置错误；HTTP 401/403=auth；400=bad request；其余=upstream；
       网络异常=request —— 全部沿 ok:false 进入既有 failure/fallback 机制。 */
    const t = (config.ttsMimo && typeof config.ttsMimo === 'object') ? config.ttsMimo : {};
    if (!t.enabled || !t.endpoint || !t.apiKey) {
      return { ok: false, error: 'MiMo TTS not configured: edit config.json ttsMimo section (enabled/endpoint/apiKey)' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const messages = [];
      if (profile.style) messages.push({ role: 'user', content: profile.style });
      messages.push({ role: 'assistant', content: String(profile.text).slice(0, 4000) });
      const body = {
        model: profile.model || MIMO_DEFAULT_MODEL,
        messages: messages,
        audio: { format: 'mp3', voice: profile.voice.id || t.voice || MIMO_DEFAULT_VOICE }
      };
      const res = await fetch(t.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': t.apiKey || ''
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        const kind = res.status === 401 || res.status === 403 ? 'auth' : (res.status === 400 ? 'bad request' : 'upstream');
        return { ok: false, error: 'MiMo TTS failed (' + kind + ', HTTP ' + res.status + '): ' + err.slice(0, 200) };
      }
      const data = await res.json().catch(() => null);
      const b64 = data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.audio && data.choices[0].message.audio.data;
      if (!b64) return { ok: false, error: 'MiMo TTS returned no audio data' };
      let buf = null;
      try { buf = Buffer.from(b64, 'base64'); } catch (e) { /* base64 解码失败按空音频处理 */ }
      if (!buf || !buf.length) return { ok: false, error: 'MiMo TTS returned empty audio' };
      return saveTtsAudio(buf, { lang: '' });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: 'MiMo TTS request: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  async function mimoCloneSynthesize(profile) {
    /* MiMo VoiceClone（mimo-v2.5-tts-voiceclone，第三阶段 B2）。
       官方文档（mimo.mi.com）确认的 shape：
         - audio.voice 必填且为 data:{MIME};base64,<b64>（仅 mp3/wav 样本，Base64 编码后 ≤10 MB）
         - user 消息可选，非空即自然语言风格指令（voice.style ⇒ user.content）
         - assistant 消息必填，承载目标合成文本
         - 不用普通内置 voiceId 克隆（音色由参考音频决定）；无独立 language；无 rate/pitch
       空引用 / 文件丢失 / 超官方大小限制一律本地失败，绝不发给 MiMo。 */
    const t = (config.ttsMimo && typeof config.ttsMimo === 'object') ? config.ttsMimo : {};
    if (!t.enabled || !t.endpoint || !t.apiKey) {
      return { ok: false, error: 'MiMo TTS not configured: edit config.json ttsMimo section (enabled/endpoint/apiKey)' };
    }
    const refId = profile.voice && profile.voice.data && profile.voice.data.refAudioId;
    if (!refId || typeof refId !== 'string' || !ttsVoices.getRefAudioMeta(refId)) {
      return { ok: false, error: 'Reference Audio 不存在' };
    }
    const resolved = ttsVoices.resolveRefAudio(refId);
    if (!resolved) return { ok: false, error: 'Reference Audio 文件已丢失（注册表存在但文件缺失）' };
    let buf = null;
    try { buf = fs.readFileSync(resolved.file); } catch (e) {
      return { ok: false, error: 'Reference Audio 文件读取失败：' + String(e && e.message || e).slice(0, 120) };
    }
    if (!buf || !buf.length) return { ok: false, error: 'Reference Audio 文件为空' };
    const b64 = buf.toString('base64');
    if (b64.length > MIMO_CLONE_MAX_B64) {
      return { ok: false, error: 'Reference Audio Base64 编码后超过 10 MB 上限（MiMo VoiceClone 拒绝）' };
    }
    /* data URI 的 MIME 必须与样本真实格式一致（B1 上传时已用 magic bytes 校验） */
    const mime = (resolved.meta.mime === 'audio/wav') ? 'audio/wav' : 'audio/mpeg';
    const voiceDataUri = 'data:' + mime + ';base64,' + b64;
    const messages = [];
    messages.push({ role: 'user', content: profile.style || '' });
    messages.push({ role: 'assistant', content: String(profile.text).slice(0, 4000) });
    const model = (profile.model && typeof profile.model === 'string') ? profile.model : MIMO_CLONE_MODEL;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const body = {
        model: model,
        messages: messages,
        audio: { format: 'mp3', voice: voiceDataUri }
      };
      const res = await fetch(t.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': t.apiKey || ''
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        const kind = res.status === 401 || res.status === 403 ? 'auth' : (res.status === 400 ? 'bad request' : 'upstream');
        return { ok: false, error: 'MiMo VoiceClone failed (' + kind + ', HTTP ' + res.status + '): ' + err.slice(0, 200) };
      }
      const data = await res.json().catch(() => null);
      const b64out = data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.audio && data.choices[0].message.audio.data;
      if (!b64out) return { ok: false, error: 'MiMo VoiceClone returned no audio data' };
      let outbuf = null;
      try { outbuf = Buffer.from(b64out, 'base64'); } catch (e) { /* base64 解码失败按空音频处理 */ }
      if (!outbuf || !outbuf.length) return { ok: false, error: 'MiMo VoiceClone returned empty audio' };
      return saveTtsAudio(outbuf, { lang: '' });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: 'MiMo VoiceClone request: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  async function mimoDesignSynthesize(profile) {
    /* MiMo Voice Design（mimo-v2.5-tts-voicedesign，第三阶段 C）。
       官方文档（mimo.mi.com）确认的 shape：
         - role:"user" 的 content = 音色设计描述（必填）
         - role:"assistant" 的 content = 目标合成文本（必填）
         - 不用 audio.voice（音色由描述生成，非参考音频/预置音色）；无独立 language；无 rate/pitch
         - audio.format 默认 wav；通用文档允许 mp3。为兼容现有 .mp3 播放链，输出请求 mp3。
       空设计描述本地失败，绝不发空 user 消息给上游。 */
    const t = (config.ttsMimo && typeof config.ttsMimo === 'object') ? config.ttsMimo : {};
    if (!t.enabled || !t.endpoint || !t.apiKey) {
      return { ok: false, error: 'MiMo TTS not configured: edit config.json ttsMimo section (enabled/endpoint/apiKey)' };
    }
    const designPrompt = (typeof profile.style === 'string') ? profile.style.trim() : '';
    if (!designPrompt) return { ok: false, error: 'Voice Design 需要音色描述（voice.style）' };
    const messages = [
      /* 官方明确：voicedesign 下 user 消息必填 = 音色设计描述；长度官方仅有「1–4 句即可」的写作建议，无硬性数字，这里做防御性截断 */
      { role: 'user', content: designPrompt.slice(0, 2000) },
      { role: 'assistant', content: String(profile.text).slice(0, 4000) }
    ];
    /* 官方响应不产生可复用 Voice ID/asset（audio.id 为响应级标识、expires_at=null），
       设计输出即直接可播放音频，无需额外持久化资产。 */
    const model = (profile.model && typeof profile.model === 'string') ? profile.model : MIMO_DESIGN_MODEL;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const body = {
        model: model,
        messages: messages,
        audio: { format: 'mp3' }
      };
      const res = await fetch(t.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': t.apiKey || ''
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        const kind = res.status === 401 || res.status === 403 ? 'auth' : (res.status === 400 ? 'bad request' : 'upstream');
        return { ok: false, error: 'MiMo Voice Design failed (' + kind + ', HTTP ' + res.status + '): ' + err.slice(0, 200) };
      }
      const data = await res.json().catch(() => null);
      const b64out = data && data.choices && data.choices[0] && data.choices[0].message
        && data.choices[0].message.audio && data.choices[0].message.audio.data;
      if (!b64out) return { ok: false, error: 'MiMo Voice Design returned no audio data' };
      let outbuf = null;
      try { outbuf = Buffer.from(b64out, 'base64'); } catch (e) { /* base64 解码失败按空音频处理 */ }
      if (!outbuf || !outbuf.length) return { ok: false, error: 'MiMo Voice Design returned empty audio' };
      return saveTtsAudio(outbuf, { lang: '' });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: 'MiMo Voice Design request: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  /* ── Provider Registry（能力模型）────────────────────────────────
     capabilities：builtin / clone / design / style / language / prosody。
     各 provider 只声明官方 API 实际支持的参数：
       Edge → builtin 音色 + rate/pitch（prosody）；SSML xml:lang 固定 zh-CN；
              clone/design/style 无。language 记为不支持。
       OpenAI → builtin 音色 + model 选择 + instructions（style）；无 prosody/language 参数。
       MiMo → builtin 音色枚举 + model（mimo-v2.5-tts）+ 自然语言指令（style ⇒ user 消息）；
              无独立 language 参数（语言由预置音色决定）；无 rate/pitch；
              B2 clone=true（mimo-v2.5-tts-voiceclone，audio.voice 为参考音频 data URI）；
              C 起 design=true（mimo-v2.5-tts-voicedesign，user 消息=音色设计描述，无 audio.voice）。
     只有 mimo.clone===mimo.design===true：edge/openai + clone/design 仍被 normalize 回落 builtin。 */
  const TTS_PROVIDER_REGISTRY = {
    edge: {
      id: 'edge',
      label: 'Edge TTS (free)',
      capabilities: { builtin: true, clone: false, design: false, style: false, language: false, prosody: true },
      defaultVoice: EDGE_DEFAULT_VOICE,
      defaultLanguage: EDGE_DEFAULT_LANGUAGE,
      models: [],
      synthesize: edgeSynthesize
    },
    openai: {
      id: 'openai',
      label: 'OpenAI TTS',
      capabilities: { builtin: true, clone: false, design: false, style: true, language: false, prosody: false },
      defaultVoice: OPENAI_DEFAULT_VOICE,
      defaultLanguage: '',
      models: [OPENAI_DEFAULT_MODEL, 'tts-1-hd', 'gpt-4o-mini-tts'],
      synthesize: openaiSynthesize
    },
    mimo: {
      id: 'mimo',
      label: 'MiMo TTS',
      capabilities: { builtin: true, clone: true, design: true, style: true, language: false, prosody: false },
      defaultVoice: MIMO_DEFAULT_VOICE,
      defaultLanguage: '',
      models: [MIMO_DEFAULT_MODEL],
      cloneModels: [MIMO_CLONE_MODEL],
      designModels: [MIMO_DESIGN_MODEL],
      builtinVoices: MIMO_BUILTIN_VOICES,
      synthesize: mimoSynthesize,
      cloneSynthesize: mimoCloneSynthesize,
      designSynthesize: mimoDesignSynthesize
    }
  };

  /*
   * normalizeVoiceProfile(raw, configOverride)
   * 统一入口前的规范化层。接受三种输入：
   *   ① 旧角色 voice 对象  { enabled?, provider, voiceId, rate, pitch, autoPlay?, ...新字段 }
   *   ② 新 Voice Profile   { provider, model, voiceType, voiceData, language, style, ... }
   *   ③ REST/WS 平铺参数   { text, voice, provider, rate, pitch, ...可选新字段 }
   * 行为：
   *   - 补齐默认值（provider 缺省沿用既有规则：配好 OpenAI 凭据则 openai 否则 edge）
   *   - 按 provider capabilities 过滤不支持的字段（不支持 ⇒ 空值，绝不发给上游）
   *   - voiceType 未知 / 当前 provider 不支持时回落 builtin（design 本阶段未实现，
   *     脏数据不允许泄漏到旧 provider；mimo.clone 已开启，clone 仅对 mimo 有效）
   *   - voice.id 等字符串不做 trim：保证请求字节与历史行为等价
   * 输出统一内部形态：
   *   { provider, model, voice:{type,id,data}, language, style, rate, pitch, text }
   */
  function normalizeVoiceProfileCore(raw, cfgSource) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const t = (cfgSource && cfgSource.tts) || {};

    /* provider：显式合法值优先；否则沿用提取前的缺省规则 */
    let prov = String(r.provider || '').toLowerCase();
    if (!TTS_PROVIDER_REGISTRY[prov]) {
      prov = (t.enabled && t.endpoint && t.apiKey ? 'openai' : 'edge');
    }
    const def = TTS_PROVIDER_REGISTRY[prov];
    const caps = def.capabilities;

    /* voice 三来源兼容：平铺 voiceId > 平铺 voice（REST/WS 旧参数）> 规范化 voice 对象（回灌） */
    const nestedVoice = (r.voice && typeof r.voice === 'object' && !Array.isArray(r.voice)) ? r.voice : null;
    let vtypeRaw = r.voiceType != null ? String(r.voiceType) : '';
    if (!vtypeRaw && nestedVoice && nestedVoice.type != null) vtypeRaw = String(nestedVoice.type);
    let vtype = String(vtypeRaw || '').toLowerCase();
    if (vtype !== 'builtin' && !(caps[vtype] === true)) vtype = 'builtin';

    let vid = '';
    if (typeof r.voice === 'string' && r.voice) vid = r.voice;
    else if (r.voiceId != null && r.voiceId !== '') vid = String(r.voiceId);
    else if (nestedVoice && nestedVoice.id != null && nestedVoice.id !== '') vid = String(nestedVoice.id);

    let vdata = null;
    if (nestedVoice && nestedVoice.data != null && typeof nestedVoice.data === 'object') vdata = nestedVoice.data;
    else if (r.voiceData != null && typeof r.voiceData === 'object') vdata = r.voiceData;

    /* model：clone/design 且 provider 声明对应模型时，强制使用官方专用模型——
       显式指定过专用 model 才保留，否则（含误留 builtin model / 空值）兜底到专用模型，
       避免「用户选了普通 TTS model 后 adapter 再猜测」。
       非 clone/design 走既有 models 规则：空值由适配器按历史回落链处理（role.model||t.model||default）。 */
    let model = '';
    if (vtype === 'clone' && Array.isArray(def.cloneModels) && def.cloneModels.length) {
      const requested = (typeof r.model === 'string') ? r.model : '';
      model = (requested && def.cloneModels.indexOf(requested) !== -1) ? requested : def.cloneModels[0];
    } else if (vtype === 'design' && Array.isArray(def.designModels) && def.designModels.length) {
      const requested = (typeof r.model === 'string') ? r.model : '';
      model = (requested && def.designModels.indexOf(requested) !== -1) ? requested : def.designModels[0];
    } else if (def.models.length && typeof r.model === 'string') {
      /* Built-in 防脏字段：误带本 provider 的 clone/design 专用 model（UI 切换残留 /
         手改 JSON / 旧数据）按「未指定」处理，交适配器默认链（role.model||t.model||default），
         绝不让 voiceType=builtin 的请求带着 clone/design model 上游。 */
      const specials = (def.cloneModels || []).concat(def.designModels || []);
      model = specials.indexOf(r.model) !== -1 ? '' : r.model;
    }

    /* language / style：capabilities 不支持 ⇒ 一律置空（不上游、不透传） */
    const language = caps.language && r.language != null ? String(r.language) : '';
    const style = caps.style && r.style != null && typeof r.style !== 'object' ? String(r.style) : '';

    /* rate/pitch：仅 prosody 型 provider 承载；原样传递（含 undefined），由 edgeTtsGen 保持原默认行为 */
    let rate = null, pitch = null;
    if (caps.prosody) {
      if (r.rate != null && typeof r.rate !== 'object') rate = r.rate;
      if (r.pitch != null && typeof r.pitch !== 'object') pitch = String(r.pitch);
    }

    const text = r.text == null ? '' : String(r.text);

    return {
      provider: prov,
      model: model,
      voice: { type: vtype, id: vid, data: vdata },
      language: language,
      style: style,
      rate: rate,
      pitch: pitch,
      text: text
    };
  }

  function normalizeVoiceProfile(raw, configOverride) {
    return normalizeVoiceProfileCore(raw, configOverride || config);
  }

  /*
   * ttsSynthesize(profile, ctx)：统一合成入口（ctx 目前保留未用，供未来会话级信息注入）。
   * 文本判空与截断语义沿用提取前 ttsGenerate / 各 provider 的两层检查，错误文案不变。
   */
  /* ── 统一合成入口：voice.type==='clone'/'design' 且 provider 有对应 synthesize 时走专用适配器；
     否则走普通 synthesize。edge/openai 的 clone/design 能力为 false，normalize 已回落到 builtin，
     因此 clone/design 请求只会命中 provider.cloneSynthesize/designSynthesize（当前仅 mimo）。 ── */
  async function ttsSynthesize(profile, ctx) {
    void ctx;
    const prof = profile && typeof profile === 'object' ? profile : {};
    const input = String(prof.text || '').trim();
    if (!input) return { ok: false, error: 'No text to speak' };
    const def = TTS_PROVIDER_REGISTRY[prof.provider];
    if (!def) return { ok: false, error: 'Unknown TTS provider: ' + prof.provider };
    const isClone = prof.voice && prof.voice.type === 'clone';
    if (isClone && def.cloneSynthesize) {
      return def.cloneSynthesize(Object.assign({}, prof, { text: input }));
    }
    const isDesign = prof.voice && prof.voice.type === 'design';
    if (isDesign && def.designSynthesize) {
      return def.designSynthesize(Object.assign({}, prof, { text: input }));
    }
    return def.synthesize(Object.assign({}, prof, { text: input }));
  }

  /* 兼容包装：旧位置参数签名保持不变（routes / WS 工具历史调用者零改动即生效） */
  async function ttsGenerate(text, voice, provider, rate, pitch) {
    return ttsSynthesize(normalizeVoiceProfile({
      text: text,
      voice: voice,
      provider: provider,
      rate: rate,
      pitch: pitch
    }));
  }

  return { edgeTtsGen, ttsGenerate, normalizeVoiceProfile, ttsSynthesize };
}

module.exports = createTts;
