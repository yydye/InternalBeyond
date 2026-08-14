/* IB Bridge · AI Voice（TTS）：OpenAI 兼容 + Edge 免费双 provider。
   从 ib-bridge-service.js 提取为工厂：config / uid / ttsDir（mp3 输出目录）经依赖注入。
   原逻辑逐字不变（含 Edge WS 帧构造与累积式帧解析的两处修复注释）。 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

function createTts(deps) {
  const config = deps.config;
  const uid = deps.uid;
  const ttsDir = deps.ttsDir;

  async function edgeTtsGen(text, voiceId, rate, pitch) {
    const input = String(text || '').trim().slice(0, 2000);
    if (!input) return { ok: false, error: 'text required' };
    const voice = String(voiceId || 'zh-CN-XiaoxiaoNeural');
    const r = String(rate || '1.0').replace('%', '');
    const p = String(pitch || '+0Hz');
    const ssml = 'X-RequestId:' + uid('r') + '\r\n' +
      'Content-Type:application/ssml+xml\r\n' +
      'Path:ssml\r\n\r\n' +
      '<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xmlns:emo="http://www.w3.org/2009/10/emotionml" version="1.0" xml:lang="zh-CN">' +
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
        const id = uid('tts');
        try { fs.writeFileSync(path.join(ttsDir, id + '.mp3'), audio); } catch (e) { resolve({ ok: false, error: 'write failed' }); return; }
        resolve({ ok: true, id, url: '/tts/' + id + '.mp3', bytes: audio.length, lang: 'zh-CN' });
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

  async function ttsGenerate(text, voice, provider, rate, pitch) {
    const input = String(text || '').trim();
    if (!input) return { ok: false, error: 'No text to speak' };
    /* provider 未指定时：若已配 OpenAI TTS 则用 openai，否则用 edge 免费 */
    const t = config.tts || {};
    const prov = String(provider || (t.enabled && t.endpoint && t.apiKey ? 'openai' : 'edge')).toLowerCase();
    if (prov === 'edge') return edgeTtsGen(input, voice, rate, pitch);

    /* OpenAI / OpenAI-compatible TTS */
    if (!t.enabled || !t.endpoint || !t.apiKey) {
      return { ok: false, error: 'TTS not configured: edit config.json tts section (enabled/endpoint/apiKey/model/voice)' };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(t.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (t.apiKey || '')
        },
        body: JSON.stringify({
          model: t.model || 'tts-1',
          input: input.slice(0, 4000),
          voice: voice || t.voice || 'alloy',
          response_format: 'mp3'
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        return { ok: false, error: 'TTS failed (HTTP ' + res.status + '): ' + err.slice(0, 200) };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return { ok: false, error: 'TTS returned empty audio' };
      const id = uid('tts');
      fs.writeFileSync(path.join(ttsDir, id + '.mp3'), buf);
      return { ok: true, id, url: '/tts/' + id + '.mp3', bytes: buf.length, lang: t.lang || 'zh-CN' };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: 'TTS request: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  return { edgeTtsGen, ttsGenerate };
}

module.exports = createTts;
