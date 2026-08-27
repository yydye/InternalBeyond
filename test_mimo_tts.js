'use strict';

/* Internal Beyond · MiMo TTS 专项测试（第三阶段 A）。
 * 零依赖：直接驱动 bridge/tts.js 的 Registry / normalizeVoiceProfile / ttsSynthesize，
 * 用本地 mock chat-completions 端点捕获请求验证 request shape、style/language
 * 空值语义与错误分类；不发起任何真实外网请求。 */

const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const createTts = require('./bridge/tts');

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 300) : '')); }
}

/* A/B/C 前置：Registry 形态静态校验 */
function registryChecks() {
  let registry = null;
  const tts = createTts({ config: {}, uid: () => 'tts_x', ttsDir: os.tmpdir() });
  /* registry 在工厂闭包内，无法直接导出——通过 synthesize 入口行为间接覆盖；
     这里用源码级断言锁定关键形态，避免为测试改动公共接口。 */
  const src = fs.readFileSync(path.join(__dirname, 'bridge', 'tts.js'), 'utf8');
  ok('A.registry.mimoExists', /mimo:\s*\{\s*id:\s*'mimo'/.test(src));
  const mimoBlock = (src.match(/mimo:\s*\{[\s\S]*?\n    \}/) || [''])[0];
  /* B2 起 mimo.clone=true（仅在 B2 VoiceClone 适配器存在后才开启）；edge/openai 仍为 false */
  ok('A.capabilities.cloneTrue', /clone:\s*true/.test(mimoBlock), mimoBlock.slice(0, 200));
  ok('A.capabilities.cloneModels', /cloneModels:\s*\[/.test(mimoBlock) && src.includes("MIMO_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'"));
  /* C 起 mimo.design=true（mimo-v2.5-tts-voicedesign）；edge/openai 仍为 false */
  ok('A.capabilities.designTrue', /design:\s*true/.test(mimoBlock), mimoBlock.slice(0, 200));
  ok('A.capabilities.designModels', /designModels:\s*\[/.test(mimoBlock) && src.includes("MIMO_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'"));
  ok('A.capabilities.styleTrue', /style:\s*true/.test(mimoBlock));
  ok('B.model.mimoV25Tts', /models:\s*\[MIMO_DEFAULT_MODEL\]/.test(mimoBlock) && src.includes("MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts'"));
  ok('C.defaultVoice.mimoDefault', src.includes("MIMO_DEFAULT_VOICE = 'mimo_default'"));
  void tts; void registry;
}

async function main() {
  console.log('== Internal Beyond · MiMo TTS 专项测试 ==');
  registryChecks();

  let lastReq = null;
  const AUDIO_B64 = Buffer.from('MIMOAUDIO').toString('base64');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      lastReq = {
        method: req.method,
        url: req.url,
        headers: { apiKey: req.headers['api-key'] || '', auth: req.headers.authorization || '', ct: req.headers['content-type'] || '' },
        body: JSON.parse(body || '{}')
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', audio: { data: AUDIO_B64 } } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  function mimoConfig(extra) {
    return { tts: {}, ttsMimo: Object.assign({ enabled: true, endpoint: 'http://127.0.0.1:' + port + '/v1/chat/completions', apiKey: 'mimo-key-123', voice: '' }, extra || {}) };
  }
  const ttsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mimo-tts-'));
  function newTts(cfg) { return createTts({ config: cfg, uid: p => p + '_uid', ttsDir: ttsDir }); }

  try {
    /* ── B. Normalize：MiMo Profile 内部形态 ── */
    {
      const t = newTts(mimoConfig());
      const prof = t.normalizeVoiceProfile({ enabled: true, provider: 'mimo', model: 'mimo-v2.5-tts', voiceId: 'Chloe', rate: 2, pitch: '+10Hz', autoPlay: true, language: 'zh', style: '温柔一点', voiceType: 'builtin', voiceData: null });
      assert.deepStrictEqual(
        [prof.provider, prof.model, prof.voice.id, prof.style],
        ['mimo', 'mimo-v2.5-tts', 'Chloe', '温柔一点']
      );
      /* capabilities 过滤：MiMo 无 prosody/language ⇒ rate/pitch/language 被清空 */
      assert.strictEqual(prof.rate, null);
      assert.strictEqual(prof.pitch, null);
      assert.strictEqual(prof.language, '');
      assert.strictEqual(prof.voice.type, 'builtin');
      assert.strictEqual(prof.voice.data, null);
      ok('B.normalize.mimoProfileShape', true);
    }

    /* ── C/D/E/F/G. 请求 Shape 与默认值/空字段 ── */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '你好世界', provider: 'mimo', model: '', voiceId: '', style: '' }));
      ok('E.synth.ok', r.ok === true && r.url.indexOf('/tts/') === 0 && typeof r.bytes === 'number' && r.bytes > 0, JSON.stringify(r));
      ok('E.method.url', lastReq.method === 'POST' && lastReq.url.indexOf('/v1/chat/completions') > -1, lastReq.url);
      ok('E.header.apiKey', lastReq.headers.apiKey === 'mimo-key-123' && !lastReq.headers.auth, JSON.stringify(lastReq.headers));
      ok('E.header.ct', lastReq.headers.ct.indexOf('application/json') === 0);
      const b = lastReq.body;
      ok('E.body.modelDefault', b.model === 'mimo-v2.5-tts', JSON.stringify(b.model));
      ok('E.body.textInAssistant', Array.isArray(b.messages) && b.messages.length === 1 && b.messages[0].role === 'assistant' && b.messages[0].content === '你好世界', JSON.stringify(b.messages));
      ok('F.emptyStyle.omitsUserMessage', !b.messages.some(m => m.role === 'user'), JSON.stringify(b.messages));
      ok('D.noEmptyLanguageParam', Object.keys(b).indexOf('language') === -1 && (!b.audio || Object.keys(b.audio).indexOf('language') === -1), JSON.stringify(b));
      ok('G.language.neverSent', JSON.stringify(b).indexOf('"language"') === -1);
      ok('E.audio.formatMp3VoiceDefault', b.audio && b.audio.format === 'mp3' && b.audio.voice === 'mimo_default', JSON.stringify(b.audio));
    }

    /* 显式 voiceId + 非空 style ⇒ user 消息承载指令；assistant 承载正文 */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      const r = await t.ttsSynthesize(t.normalizeVoiceProfile({ text: '早上好呀', provider: 'mimo', voiceId: 'Chloe', style: '自然、温柔', autoPlay: true }));
      assert.ok(r.ok === true);
      ok('F.style.nonEmptySendsUserMessage', lastReq.body.messages.length === 2 && lastReq.body.messages[0].role === 'user' && lastReq.body.messages[0].content === '自然、温柔' && lastReq.body.messages[1].content === '早上好呀', JSON.stringify(lastReq.body.messages));
      ok('E.voice.passthroughEnum', lastReq.body.audio.voice === 'Chloe', JSON.stringify(lastReq.body.audio));
    }

    /* 语言字段对 MiMo 无 API 参数：显式填写也不产生请求参数（落到消息里更是禁止的） */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      for (const lang of ['', 'zh', 'en']) {
        await t.ttsSynthesize(t.normalizeVoiceProfile({ text: 'lang probe', provider: 'mimo', language: lang, voiceId: 'Mia' }));
        ok('G.language.' + (lang || 'empty') + '.notSent', JSON.stringify(lastReq.body).indexOf('"language"') === -1 && lastReq.body.audio.voice === 'Mia');
      }
    }

    /* ── 错误分类：配置错误 / auth / bad request / upstream / 网络 ── */
    {
      const unconfigured = newTts({ tts: {}, ttsMimo: { enabled: false, endpoint: '', apiKey: '' } });
      const r = await unconfigured.ttsSynthesize(unconfigured.normalizeVoiceProfile({ text: 'x', provider: 'mimo' }));
      ok('H.configError', r.ok === false && r.error.indexOf('not configured') > -1 && r.error.indexOf('ttsMimo') > -1, r.error);

      async function withStatusMock(status, checkName, expectedTag) {
        const s2 = http.createServer((req, res) => {
          let body = '';
          req.on('data', c => { body += c; });
          req.on('end', () => { void body; res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end('boom'); });
        });
        await new Promise(r => s2.listen(0, '127.0.0.1', r));
        const p2 = s2.address().port;
        const t2 = newTts({ tts: {}, ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:' + p2 + '/v1/chat/completions', apiKey: 'k' } });
        const out = await t2.ttsSynthesize(t2.normalizeVoiceProfile({ text: 'x', provider: 'mimo' }));
        ok(checkName, out.ok === false && out.error.indexOf(expectedTag) > -1 && out.error.indexOf(String(status)) > -1, out.error);
        await new Promise(r => s2.close(r));
      }
      await withStatusMock(401, 'H.authError401', 'auth');
      await withStatusMock(403, 'H.authError403', 'auth');
      await withStatusMock(400, 'H.badRequest400', 'bad request');
      await withStatusMock(500, 'H.upstream500', 'upstream');

      /* 无数据体响应 → no audio data */
      const noAudio = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => { void body; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: {} }] })); });
      });
      await new Promise(r => noAudio.listen(0, '127.0.0.1', r));
      const naPort = noAudio.address().port;
      const tn = newTts({ tts: {}, ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:' + naPort + '/v1/chat/completions', apiKey: 'k' } });
      const outN = await tn.ttsSynthesize(tn.normalizeVoiceProfile({ text: 'x', provider: 'mimo' }));
      ok('H.noAudioData', outN.ok === false && outN.error === 'MiMo TTS returned no audio data', outN.error);
      await new Promise(r => noAudio.close(r));

      /* 网络错误（连接拒绝端口）→ MiMo TTS request 前缀 */
      const deadT = newTts({ tts: {}, ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'k' } });
      const outDead = await deadT.ttsSynthesize(deadT.normalizeVoiceProfile({ text: 'x', provider: 'mimo' }));
      ok('H.networkError', outDead.ok === false && outDead.error.indexOf('MiMo TTS request:') === 0, outDead.error);
    }

    /* ── 兼容包装：旧位置参数也能指定 provider=mimo ── */
    {
      const t = newTts(mimoConfig());
      lastReq = null;
      const r = await t.ttsGenerate('包装器路径', '白桦', 'mimo');
      ok('I.legacyWrapper.mimoPath', r.ok === true && lastReq.body.audio.voice === '白桦' && lastReq.body.messages[0].content === '包装器路径', JSON.stringify(lastReq && lastReq.body));
    }

    /* ── Edge/OpenAI 不受影响：openai 仍走 Bearer + /audio/speech 四字段 ── */
    {
      let openaiSeen = null;
      const oai = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          openaiSeen = { url: req.url, auth: req.headers.authorization || '', apiKey: req.headers['api-key'] || '', body: JSON.parse(body || '{}') };
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(Buffer.from('MP3FAKE'));
        });
      });
      await new Promise(r => oai.listen(0, '127.0.0.1', r));
      const op = oai.address().port;
      const t = newTts({ tts: { enabled: true, endpoint: 'http://127.0.0.1:' + op + '/v1/audio/speech', apiKey: 'oaik', model: 'tts-1', voice: 'alloy', lang: 'zh-CN' }, ttsMimo: mimoConfig().ttsMimo });
      const r = await t.ttsGenerate('hi', 'alloy', 'openai');
      assert.ok(r.ok === true);
      ok('J.openaiUnchanged', openaiSeen.auth === 'Bearer oaik' && !openaiSeen.apiKey && openaiSeen.body.input === 'hi' && openaiSeen.body.response_format === 'mp3', JSON.stringify(openaiSeen.body));
      await new Promise(r => oai.close(r));
    }

    console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
      : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
    process.exitCode = failCount ? 1 : 0;
  } finally {
    await new Promise(r => server.close(r));
    try { fs.rmSync(ttsDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

main().catch(e => { console.error('test_mimo_tts fatal:', e && e.message || e); process.exit(1); });
