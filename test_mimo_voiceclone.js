'use strict';

/* Internal Beyond · MiMo VoiceClone（mimo-v2.5-tts-voiceclone）专项测试（第三阶段 B2）。
 * 零依赖：直接驱动 bridge/tts.js（Registry / normalizeVoiceProfile / ttsSynthesize）+
 * bridge/tts-voices.js（B1 Reference Audio 资产层），用本地 mock chat-completions 端点
 * 捕获真实 request shape 验证。覆盖：Registry、Normalize、Reference Audio 解析、Base64
 * 一致性、请求 shape、style、空引用、注册表-文件不一致、超官方 Base64 上限、builtin 回归。
 * 不发起任何真实外网请求；所有断言以 2026-07 官方文档（api.xiaomimimo.com/v1/chat/completions）为准。 */

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const createTts = require('./bridge/tts');
const createTtsVoices = require('./bridge/tts-voices');

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 240) : '')); }
}

/* ── 测试音频样本（B1 资产）── */
function wav(extra) {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVE'), Buffer.from(extra || [1, 2, 3, 4])]);
}
function mp3Id3(extra) {
  const head = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, Buffer.from(extra || [5, 6, 7, 8, 9])]);
}

/* 直接驱动模块测试（不 spawn 整个 Bridge，规则同 test_mimo_tts.js 的 mock 端点思路） */
async function main() {
  console.log('== Internal Beyond · MiMo VoiceClone（B2）测试 ==');

  /* ── Registry 形态（源码级，与 test_mimo_tts.js 同风格）── */
  {
    const src = fs.readFileSync(path.join(__dirname, 'bridge', 'tts.js'), 'utf8');
    ok('A.registry.cloneModelConst', src.includes("MIMO_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'"));
    ok('A.registry.cloneCapabilityMimoOnly', /mimo:\s*\{[\s\S]*?clone:\s*true[\s\S]*?cloneSynthesize: mimoCloneSynthesize/.test(src));
    const edgeBlock = (src.match(/edge:\s*\{[\s\S]*?\n    \}/) || [''])[0];
    const openaiBlock = (src.match(/openai:\s*\{[\s\S]*?\n    \}/) || [''])[0];
    ok('A.registry.edgeCloneFalse', /clone:\s*false/.test(edgeBlock));
    ok('A.registry.openaiCloneFalse', /clone:\s*false/.test(openaiBlock));
    ok('A.registry.edgeNoCloneSynthesize', edgeBlock.indexOf('cloneSynthesize') === -1);
    ok('A.registry.openaiNoCloneSynthesize', openaiBlock.indexOf('cloneSynthesize') === -1);
  }

  /* ── mock MiMo endpoint：捕获真实 request shape ── */
  let lastReq = null;
  let requestCount = 0;
  const AUDIO_OUT = Buffer.from('VOICECLONE_MP3_FAKE').toString('base64');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requestCount++;
      lastReq = {
        method: req.method,
        url: req.url,
        headers: { apiKey: req.headers['api-key'] || '', auth: req.headers.authorization || '', ct: req.headers['content-type'] || '' },
        body: JSON.parse(body || '{}')
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', audio: { data: AUDIO_OUT, id: 'audio-1', expires_at: null, transcript: null } } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mimo-clone-'));
  const ttsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mimo-clone-tts-'));
  let voices = null;
  try {
    /* B1 Reference Audio 资产层（写盘 + 注册表 + resolve） */
    voices = createTtsVoices({ dataDir, writeJson: (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); return true; } catch (e) { return false; } }, loadJson: (n, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, n + '.json'), 'utf8')); } catch (e) { return fb; } } });
    function mimoConfig(extra) {
      return { tts: {}, ttsMimo: Object.assign({ enabled: true, endpoint: 'http://127.0.0.1:' + port + '/v1/chat/completions', apiKey: 'mimo-key-123', voice: '' }, extra || {}) };
    }
    function newTts(cfg) { return createTts({ config: cfg, uid: p => p + '_uid', ttsDir, ttsVoices: voices }); }

    /* ── B. Normalize：mimo + clone + refAudioId → clone 内部形态 ── */
    {
      const t = newTts(mimoConfig());
      const prof = t.normalizeVoiceProfile({ text: '克隆测试文本', provider: 'mimo', voiceType: 'clone', voiceId: 'Chloe', model: 'mimo-v2.5-tts', voiceData: { refAudioId: 'REFAUDIO_1', mime: 'audio/mpeg', name: 'a.mp3', size: 100 } });
      assert.strictEqual(prof.provider, 'mimo');
      assert.strictEqual(prof.voice.type, 'clone');
      /* model 被强制落到官方克隆模型（即便误填了 builtin model） */
      assert.strictEqual(prof.model, 'mimo-v2.5-tts-voiceclone');
      assert.strictEqual(prof.voice.data.refAudioId, 'REFAUDIO_1');
      /* 无 prosody / language */
      assert.strictEqual(prof.rate, null);
      assert.strictEqual(prof.pitch, null);
      assert.strictEqual(prof.language, '');
      ok('B.normalize.cloneProfileShape', true);
    }
    /* clone + 显式 clone model → 保留 */
    {
      const t = newTts(mimoConfig());
      const prof = t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'clone', model: 'mimo-v2.5-tts-voiceclone', voiceData: { refAudioId: 'R2' } });
      ok('B.normalize.cloneModelKept', prof.model === 'mimo-v2.5-tts-voiceclone');
    }

    /* ── C/D. Reference Audio 解析 + Base64 一致性 ── */
    const upWav = voices.saveRefAudio({ buf: wav([9, 9, 9]), contentType: 'audio/wav', originalName: 'ref.wav' });
    assert.ok(upWav.ok === true);
    const upMp3 = voices.saveRefAudio({ buf: mp3Id3([7, 7]), contentType: 'audio/mpeg', originalName: 'ref.mp3' });
    assert.ok(upMp3.ok === true);
    const wavId = upWav.voice.refAudioId;
    const mp3Id = upMp3.voice.refAudioId;

    /* ── E. Request shape + D. Base64 ── */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '你好，克隆音色', provider: 'mimo', voiceType: 'clone', voiceData: { refAudioId: mp3Id } }));
      assert.ok(r.ok === true && r.url.indexOf('/tts/') === 0 && r.bytes > 0);
      ok('E.clone.synth.ok', r.ok === true);
      ok('E.method.url', lastReq.method === 'POST' && lastReq.url.indexOf('/v1/chat/completions') > -1);
      ok('E.header.apiKey', lastReq.headers.apiKey === 'mimo-key-123' && !lastReq.headers.auth);
      ok('E.header.ct', lastReq.headers.ct.indexOf('application/json') === 0);
      const b = lastReq.body;
      ok('E.body.model', b.model === 'mimo-v2.5-tts-voiceclone', JSON.stringify(b.model));
      ok('E.body.assistantText', Array.isArray(b.messages) && b.messages.some(m => m.role === 'assistant' && m.content === '你好，克隆音色'));
      ok('E.body.userPresent', Array.isArray(b.messages) && b.messages[0] && b.messages[0].role === 'user');
      ok('E.body.audioShape', b.audio && b.audio.format === 'mp3' && typeof b.audio.voice === 'string');
      ok('E.body.noLanguage', JSON.stringify(b).indexOf('"language"') === -1);
      ok('E.body.noRatePitch', JSON.stringify(b).indexOf('"rate"') === -1 && JSON.stringify(b).indexOf('"pitch"') === -1);
      /* 官方要求：data:{MIME};base64,<b64>，且 base64 解码 == 原文件（无 UTF-8 损坏） */
      const prefix = 'data:audio/mpeg;base64,';
      ok('E.voice.dataUriPrefix', b.audio.voice.indexOf(prefix) === 0, b.audio.voice.slice(0, 40));
      const decoded = Buffer.from(b.audio.voice.slice(prefix.length), 'base64');
      ok('D.base64.exactMatch', decoded.equals(mp3Id3([7, 7])), decoded.length + ' vs ' + mp3Id3([7, 7]).length);
    }
    /* WAV 样本 → data:audio/wav */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'clone', voiceData: { refAudioId: wavId } }));
      ok('E.voice.wavMime', lastReq.body.audio.voice.indexOf('data:audio/wav;base64,') === 0);
    }

    /* ── F. Style：空 / 非空 → user.content ── */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'style 空', provider: 'mimo', voiceType: 'clone', style: '', voiceData: { refAudioId: mp3Id } }));
      ok('F.style.empty', lastReq.body.messages[0].role === 'user' && lastReq.body.messages[0].content === '');
      lastReq = null;
      await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'style 非空', provider: 'mimo', voiceType: 'clone', style: '自然、温柔', voiceData: { refAudioId: mp3Id } }));
      ok('F.style.nonEmpty', lastReq.body.messages[0].role === 'user' && lastReq.body.messages[0].content === '自然、温柔');
    }

    /* ── G. Missing refAudio（空 / 不存在）→ 本地失败，绝不发请求 ── */
    {
      const t = newTts(mimoConfig());
      requestCount = 0; lastReq = null;
      const r1 = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'clone', voiceData: {} }));
      ok('G.missing.emptyRef', r1.ok === false && /Reference Audio 不存在/.test(r1.error), r1.error);
      const r2 = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'clone', voiceData: { refAudioId: 'nonexistent12345' } }));
      ok('G.missing.notFound', r2.ok === false && /Reference Audio 不存在/.test(r2.error), r2.error);
      ok('G.missing.noRequest', requestCount === 0, 'requests=' + requestCount);
    }

    /* ── H. 注册表存在但文件缺失 → 本地失败 ── */
    {
      const t = newTts(mimoConfig());
      const up = voices.saveRefAudio({ buf: wav([1]), contentType: 'audio/wav', originalName: 'gone.wav' });
      assert.ok(up.ok === true);
      /* 直接删掉磁盘文件（模拟磁盘丢失），注册表仍保留 entry */
      fs.unlinkSync(path.join(voices.voicesDir, up.voice.refAudioId + '.wav'));
      requestCount = 0; lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'clone', voiceData: { refAudioId: up.voice.refAudioId } }));
      ok('H.corruptRegistry', r.ok === false && /文件已丢失/.test(r.error), r.error);
      ok('H.noRequest', requestCount === 0);
    }

    /* ── I. 超官方 Base64 上限 → 本地拒绝 ── */
    {
      const t = newTts(mimoConfig());
      /* B1 允许 10 MB 原文件上传；此处用 ~8 MB 原文件 → base64 ≈ 10.67 MB > 10 MB 官方上限 */
      const big = Buffer.concat([mp3Id3(), Buffer.alloc(8 * 1024 * 1024)]);
      const up = voices.saveRefAudio({ buf: big, contentType: 'audio/mpeg', originalName: 'big.mp3' });
      assert.ok(up.ok === true);
      requestCount = 0; lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'clone', voiceData: { refAudioId: up.voice.refAudioId } }));
      ok('I.oversized.localRefuse', r.ok === false && /Base64 编码后超过 10 MB/.test(r.error), r.error);
      ok('I.noRequest', requestCount === 0);
    }

    /* ── J. Built-in 回归：mimo + builtin → 普通 TTS，绝不进 clone ── */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '内置音色', provider: 'mimo', voiceType: 'builtin', voiceId: 'Chloe', model: 'mimo-v2.5-tts' }));
      assert.ok(r.ok === true);
      const b = lastReq.body;
      ok('J.builtin.model', b.model === 'mimo-v2.5-tts', JSON.stringify(b.model));
      ok('J.builtin.voicePreset', b.audio && b.audio.voice === 'Chloe', JSON.stringify(b.audio));
      ok('J.builtin.noDataUri', b.audio && typeof b.audio.voice === 'string' && b.audio.voice.indexOf('data:') !== 0);
      ok('J.builtin.singleMessage', Array.isArray(b.messages) && b.messages.length === 1 && b.messages[0].role === 'assistant', JSON.stringify(b.messages));
    }

    /* ── 未配置：clone 也走配置错误── */
    {
      const unconfigured = newTts({ tts: {}, ttsMimo: { enabled: false, endpoint: '', apiKey: '' } });
      const r = await unconfigured.ttsSynthesize(unconfigured.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'clone', voiceData: { refAudioId: mp3Id } }));
      ok('K.unconfigured', r.ok === false && /not configured/.test(r.error), r.error);
    }

    console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')' : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
    process.exitCode = failCount ? 1 : 0;
  } finally {
    await new Promise(r => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(ttsDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

main().catch(e => { console.error('test_mimo_voiceclone fatal:', e && e.stack || e); process.exit(1); });
