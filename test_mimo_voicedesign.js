'use strict';

/* Internal Beyond · MiMo Voice Design（mimo-v2.5-tts-voicedesign）专项测试（第三阶段 C）。
 * 零依赖：直接驱动 bridge/tts.js（Registry / normalizeVoiceProfile / ttsSynthesize）+
 * bridge/tts-voices.js（B1 资产层，用于 VoiceClone 回归），用本地 mock chat-completions 端点
 * 捕获真实 request shape 验证。覆盖：Registry(design)、normalize design、非 mimo+design 回落 builtin、
 * design model 默认值、request shape、design 输入映射、不发送官方不存在的 language/rate/pitch、
 * 空描述本地拒绝、未配置、错误分类、Built-in/VoiceClone/OpenAI 回归、voiceData futureField 保留。
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

/* 测试音频样本（B1 资产，用于 clone 回归） */
function mp3Id3(extra) {
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]), Buffer.from(extra || [5, 6, 7])]);
}

async function main() {
  console.log('== Internal Beyond · MiMo Voice Design（C）测试 ==');

  /* ── Registry 形态（源码级）── */
  {
    const src = fs.readFileSync(path.join(__dirname, 'bridge', 'tts.js'), 'utf8');
    ok('A.registry.designModelConst', src.includes("MIMO_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'"));
    ok('A.registry.designCapabilityMimoOnly', /mimo:\s*\{[\s\S]*?design:\s*true[\s\S]*?designSynthesize: mimoDesignSynthesize/.test(src));
    const edgeBlock = (src.match(/edge:\s*\{[\s\S]*?\n    \}/) || [''])[0];
    const openaiBlock = (src.match(/openai:\s*\{[\s\S]*?\n    \}/) || [''])[0];
    ok('A.registry.edgeDesignFalse', /design:\s*false/.test(edgeBlock));
    ok('A.registry.openaiDesignFalse', /design:\s*false/.test(openaiBlock));
    ok('A.registry.edgeNoDesignSynth', edgeBlock.indexOf('designSynthesize') === -1);
    ok('A.registry.openaiNoDesignSynth', openaiBlock.indexOf('designSynthesize') === -1);
  }

  /* ── mock 端点 ── */
  let lastReq = null;
  let requestCount = 0;
  const AUDIO_OUT = Buffer.from('VOICEDESIGN_MP3_FAKE').toString('base64');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requestCount++;
      lastReq = { method: req.method, url: req.url, headers: { apiKey: req.headers['api-key'] || '', auth: req.headers.authorization || '', ct: req.headers['content-type'] || '' }, body: JSON.parse(body || '{}') };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', audio: { data: AUDIO_OUT, id: 'audio-9', expires_at: null, transcript: null } } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mimo-design-'));
  const ttsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mimo-design-tts-'));
  try {
    const voices = createTtsVoices({ dataDir, writeJson: (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); return true; } catch (e) { return false; } }, loadJson: (n, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, n + '.json'), 'utf8')); } catch (e) { return fb; } } });
    function mimoConfig(extra) {
      return { tts: {}, ttsMimo: Object.assign({ enabled: true, endpoint: 'http://127.0.0.1:' + port + '/v1/chat/completions', apiKey: 'mimo-key-123', voice: '' }, extra || {}) };
    }
    function newTts(cfg) { return createTts({ config: cfg, uid: p => p + '_uid', ttsDir, ttsVoices: voices }); }

    /* ── B. Normalize design ── */
    {
      const t = newTts(mimoConfig());
      const prof = t.normalizeVoiceProfile({ text: '设计音色文本', provider: 'mimo', voiceType: 'design', voiceId: 'Chloe', model: 'mimo-v2.5-tts', style: '一位年迈的先生，嗓音略带沙哑与沧桑感。', voiceData: { futureField: 'keep-me' } });
      assert.strictEqual(prof.provider, 'mimo');
      assert.strictEqual(prof.voice.type, 'design');
      /* model 强制落到官方专用 model（即便误填 builtin model） */
      assert.strictEqual(prof.model, 'mimo-v2.5-tts-voicedesign');
      assert.strictEqual(prof.style, '一位年迈的先生，嗓音略带沙哑与沧桑感。');
      /* 无 prosody / language */
      assert.strictEqual(prof.rate, null);
      assert.strictEqual(prof.pitch, null);
      assert.strictEqual(prof.language, '');
      /* voiceData futureField 在 normalize 中被保留（引用透传，不 merge 不清除） */
      assert.strictEqual(prof.voice.data.futureField, 'keep-me');
      ok('B.normalize.designShape', true);
      /* 显式指定 design model 保留 */
      const prof2 = t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'design', model: 'mimo-v2.5-tts-voicedesign', style: 's' });
      ok('B.normalize.designModelKept', prof2.model === 'mimo-v2.5-tts-voicedesign');
      /* 空 model → 强制 design model */
      const prof3 = t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'design', model: '', style: 's' });
      ok('B.normalize.designModelDefault', prof3.model === 'mimo-v2.5-tts-voicedesign');
    }

    /* ── C. 非 mimo + design → 回落 builtin ── */
    {
      const t = newTts(mimoConfig());
      const profEdge = t.normalizeVoiceProfile({ text: 'x', provider: 'edge', voiceType: 'design', voiceId: 'zh-CN-XiaoxiaoNeural' });
      ok('C.nonMimoDesignFallsBuiltin', profEdge.voice.type === 'builtin' && profEdge.provider === 'edge');
      const profOpenai = t.normalizeVoiceProfile({ text: 'x', provider: 'openai', voiceType: 'design', voiceId: 'alloy' });
      ok('C.openaiDesignFallsBuiltin', profOpenai.voice.type === 'builtin' && profOpenai.provider === 'openai');
    }

    /* ── D/E/F. Request shape + design 输入映射 + 不发送不支持字段 ── */
    {
      const t = newTts(mimoConfig());
      lastReq = null; requestCount = 0;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '你好，这是我用设计音色朗读的。', provider: 'mimo', voiceType: 'design', model: 'mimo-v2.5-tts-voicedesign', style: 'Give me a young male tone.' }));
      assert.ok(r.ok === true && r.url.indexOf('/tts/') === 0 && r.bytes > 0);
      ok('D.design.synthOk', r.ok === true);
      ok('D.method.url', lastReq.method === 'POST' && lastReq.url.indexOf('/v1/chat/completions') > -1, lastReq.url);
      ok('D.header.apiKey', lastReq.headers.apiKey === 'mimo-key-123' && !lastReq.headers.auth);
      ok('D.header.ct', lastReq.headers.ct.indexOf('application/json') === 0);
      const b = lastReq.body;
      ok('D.body.model', b.model === 'mimo-v2.5-tts-voicedesign', JSON.stringify(b.model));
      ok('E.body.designPrompt', Array.isArray(b.messages) && b.messages[0] && b.messages[0].role === 'user' && b.messages[0].content === 'Give me a young male tone.', JSON.stringify(b.messages && b.messages[0]));
      ok('E.body.targetText', Array.isArray(b.messages) && b.messages[1] && b.messages[1].role === 'assistant' && b.messages[1].content === '你好，这是我用设计音色朗读的。');
      ok('F.body.audioShape', b.audio && b.audio.format === 'mp3' && typeof b.audio.voice === 'undefined', JSON.stringify(b.audio));
      ok('F.body.noLanguage', JSON.stringify(b).indexOf('"language"') === -1);
      ok('F.body.noRatePitch', JSON.stringify(b).indexOf('"rate"') === -1 && JSON.stringify(b).indexOf('"pitch"') === -1);
      /* 官方未确认的参数不塞：无 optimize_text_preview/voice/其他猜测字段 */
      ok('F.body.noUnconfirmedFields', JSON.stringify(b).indexOf('optimize_text_preview') === -1 && Object.keys(b).sort().join(',') === 'audio,messages,model');
      /* G. response parsing */
      ok('G.response.bytes', r.ok === true && r.bytes > 0 && typeof r.url === 'string' && r.url.indexOf('/tts/') === 0);
    }

    /* ── 空 design 描述 → 本地拒绝，绝不发请求 ── */
    {
      const t = newTts(mimoConfig());
      requestCount = 0; lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'design', style: '' }));
      ok('H.emptyDesignPrompt', r.ok === false && /Voice Design 需要音色描述/.test(r.error), r.error);
      ok('H.noRequest', requestCount === 0);
    }

    /* ── 未配置 ── */
    {
      const t = newTts({ tts: {}, ttsMimo: { enabled: false, endpoint: '', apiKey: '' } });
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'design', style: 'desc' }));
      ok('I.unconfigured', r.ok === false && /not configured/.test(r.error), r.error);
    }

    /* ── 错误分类 ── */
    {
      async function withStatus(status, name, tag) {
        const s = http.createServer((req, res) => {
          let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { void b; res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end('boom'); });
        });
        await new Promise(r2 => s.listen(0, '127.0.0.1', r2));
        const p2 = s.address().port;
        const t2 = newTts({ tts: {}, ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:' + p2 + '/v1/chat/completions', apiKey: 'k' } });
        const out = await t2.ttsSynthesize(t2.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'design', style: 'desc' }));
        ok(name, out.ok === false && out.error.indexOf(tag) > -1 && out.error.indexOf(String(status)) > -1, out.error);
        await new Promise(r2 => s.close(r2));
      }
      await withStatus(401, 'J.auth401', 'auth');
      await withStatus(403, 'J.auth403', 'auth');
      await withStatus(400, 'J.badRequest400', 'bad request');
      await withStatus(500, 'J.upstream500', 'upstream');
      /* no audio data */
      const noAudio = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { void b; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: {} }] })); }); });
      await new Promise(r2 => noAudio.listen(0, '127.0.0.1', r2));
      const tn = newTts({ tts: {}, ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:' + noAudio.address().port + '/v1/chat/completions', apiKey: 'k' } });
      const outN = await tn.ttsSynthesize(tn.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceType: 'design', style: 'desc' }));
      ok('J.noAudioData', outN.ok === false && outN.error === 'MiMo Voice Design returned no audio data', outN.error);
      await new Promise(r2 => noAudio.close(r2));
    }

    /* ── VoiceClone 回归（B2）：clone 仍走 data URI ── */
    {
      const t = newTts(mimoConfig());
      const up = voices.saveRefAudio({ buf: mp3Id3([9, 9]), contentType: 'audio/mpeg', originalName: 'ref.mp3' });
      assert.ok(up.ok === true);
      lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '克隆回归文本', provider: 'mimo', voiceType: 'clone', voiceData: { refAudioId: up.voice.refAudioId } }));
      assert.ok(r.ok === true);
      ok('K.cloneRegression.model', lastReq.body.model === 'mimo-v2.5-tts-voiceclone', JSON.stringify(lastReq.body.model));
      ok('K.cloneRegression.dataUri', typeof lastReq.body.audio.voice === 'string' && lastReq.body.audio.voice.indexOf('data:audio/mpeg;base64,') === 0);
      ok('K.cloneRegression.noDesignPromptAsUser', !lastReq.body.messages.some(m => m.role === 'user' && m.content.indexOf('先生') !== -1));
    }

    /* ── Built-in 回归（B1）：mimo + builtin → 普通 TTS ── */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '内置音色文本', provider: 'mimo', voiceType: 'builtin', voiceId: 'Chloe', model: 'mimo-v2.5-tts' }));
      assert.ok(r.ok === true);
      const b = lastReq.body;
      ok('L.builtin.model', b.model === 'mimo-v2.5-tts', JSON.stringify(b.model));
      ok('L.builtin.voicePreset', b.audio && b.audio.voice === 'Chloe');
      ok('L.builtin.noDataUri', typeof b.audio.voice === 'string' && b.audio.voice.indexOf('data:') !== 0);
      ok('L.builtin.singleAssistantMsg', Array.isArray(b.messages) && b.messages.length === 1 && b.messages[0].role === 'assistant');
    }

    /* ── OpenAI 回归（file 中 openai 适配器未动）：mock /audio/speech 校验四字段 ── */
    {
      let openaiSeen = null;
      const oai = http.createServer((req, res) => {
        let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
          openaiSeen = { url: req.url, auth: req.headers.authorization || '', body: JSON.parse(b || '{}') };
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from('MP3FAKE'));
        });
      });
      await new Promise(r2 => oai.listen(0, '127.0.0.1', r2));
      const t = newTts({ tts: { enabled: true, endpoint: 'http://127.0.0.1:' + oai.address().port + '/v1/audio/speech', apiKey: 'oaik', model: 'tts-1', voice: 'alloy', lang: 'zh-CN' }, ttsMimo: mimoConfig().ttsMimo });
      const r = await t.ttsGenerate('hi', 'alloy', 'openai');
      assert.ok(r.ok === true);
      ok('M.openaiRegression', openaiSeen.auth === 'Bearer oaik' && openaiSeen.body.input === 'hi' && openaiSeen.body.response_format === 'mp3' && openaiSeen.body.voice === 'alloy', JSON.stringify(openaiSeen.body));
      await new Promise(r2 => oai.close(r2));
    }

    console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')' : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
    process.exitCode = failCount ? 1 : 0;
  } finally {
    await new Promise(r => server.close(r));
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    try { fs.rmSync(ttsDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

main().catch(e => { console.error('test_mimo_voicedesign fatal:', e && e.stack || e); process.exit(1); });
