'use strict';

/* Internal Beyond · Voice API Source 与 credential 边界专项测试（P23 Phase 1）。
 * 覆盖三类断言：
 *   A. Legacy —— 旧 voice 配置 / 旧消息读取与 normalize 不回归；
 *   B. Voice Source —— source 解析、缺失 source、endpoint 覆盖、无秘密持久化；
 *   C. Security —— apiKey 绝不进入 chatMessages / voice metadata / wire payload / 导出。
 * 零依赖、零外网：provider 请求全部打向本地 mock；浏览器侧契约用「源码内嵌函数提取」
 * 做**行为**断言（与 tests/test_mimo_tts.js 的源码级断言同一套做法）。 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const createTts = require(path.join(ROOT, 'bridge', 'tts'));
const createVoicebox = require(path.join(ROOT, 'bridge', 'voicebox'));
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* 从浏览器源码里提取一个自包含函数并真的执行它 —— 断言行为而不是断言字符串。 */
function extractFunction(file, name) {
  const src = read(file);
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}');
  const m = src.match(re);
  assert.ok(m, '未能从 ' + file + ' 提取 ' + name);
  return new Function('return (' + m[0] + ')')();
}

async function main() {
  console.log('== Internal Beyond · Voice API Source / Credential 边界测试 ==');

  const ttsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-voice-src-'));

  /* ── A. Legacy：旧配置读取 / 旧 provider 不回归 ── */
  {
    /* A1. 旧角色 voice 对象（只有 enabled/provider/voiceId/rate/pitch/autoPlay）零改动可用 */
    const cfg = { tts: { enabled: true, endpoint: 'http://127.0.0.1:1/v1/audio/speech', apiKey: 'legacy-oaik', model: 'tts-1' }, ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'legacy-mm' } };
    const t = createTts({ config: cfg, uid: p => p, ttsDir, ttsVoices: { getRefAudioMeta: () => null } });
    const legacyVoice = { enabled: true, provider: 'edge', voiceId: 'zh-CN-XiaoxiaoNeural', rate: 1.1, pitch: '+10Hz', autoPlay: true };
    const prof = t.normalizeVoiceProfile(Object.assign({ text: '旧配置' }, legacyVoice));
    ok('A1.legacy.voiceFieldsPreserved', prof.provider === 'edge' && prof.voice.id === 'zh-CN-XiaoxiaoNeural' && prof.rate === 1.1 && prof.pitch === '+10Hz', JSON.stringify(prof));
    ok('A1.legacy.sourceDerivedNotStored', prof.source === 'edge', prof.source);
    /* 历史回归：openai 无 prosody 能力 ⇒ rate/pitch 被 capabilities 过滤（与提取前逐字一致） */
    const legacyOpenai = t.normalizeVoiceProfile({ text: 'x', provider: 'openai', voiceId: 'alloy', rate: 1.1, pitch: '+0Hz' });
    ok('A1.legacy.openaiProsodyFiltered', legacyOpenai.rate === null && legacyOpenai.pitch === null && legacyOpenai.voice.id === 'alloy', JSON.stringify(legacyOpenai));
    const legacyMimo = t.normalizeVoiceProfile({ text: 'x', provider: 'mimo', voiceId: 'Chloe' });
    ok('A1.legacy.mimoSourceDerived', legacyMimo.source === 'ttsMimo' && legacyMimo.provider === 'mimo');
    const legacyEdge = t.normalizeVoiceProfile({ text: 'x', provider: 'edge', voiceId: 'zh-CN-XiaoxiaoNeural' });
    ok('A1.legacy.edgeSourceDerived', legacyEdge.source === 'edge' && legacyEdge.voice.id === 'zh-CN-XiaoxiaoNeural');
    /* 旧 voice 对象没有任何 source 字段 ⇒ 归一化输出必须仍然带 provider 语义，绝不丢 */
    ok('A1.legacy.providerNeverBlank', ['edge', 'openai', 'mimo'].indexOf(prof.provider) > -1);

    /* A2. 旧 chatMessages 记录（不含 voice）继续通过 canonical 校验并原样保留未知字段 */
    const legacyMsg = { id: 'msg_1700000000000_42', role: 'assistant', content: '旧回复', friendId: 'friend_1', timestamp: 1700000000000, reasoning_content: '', metadata: { model: 'gpt-4o', config_id: 'friend_1' }, images: [{ dataUrl: 'data:image/png;base64,AA', base64: 'AA', mime: 'image/png', name: 'a.png' }] };
    ok('A2.legacyMessage.validateOk', ChatCore.validateMessage(legacyMsg).ok === true, JSON.stringify(ChatCore.validateMessage(legacyMsg).errors));
    const canon = ChatCore.canonicalize(legacyMsg);
    ok('A2.legacyMessage.roundTrip', JSON.stringify(canon.message) === JSON.stringify(legacyMsg) && canon.dropped.length === 0, JSON.stringify(canon.dropped));
    /* A3. 用户录音消息（既有形状）继续合法，且 voice 属于 canonical 字段 */
    const userVoiceMsg = { id: 'msg_1700000000001_u', role: 'user', content: '', friendId: 'friend_1', timestamp: 1700000000001, voice: { dataUrl: 'data:audio/webm;base64,AAAA', mime: 'audio/webm', duration: 4, transcript: '你好', tone: '情绪倾向:平静/中性' } };
    ok('A3.userVoice.validateOk', ChatCore.validateMessage(userVoiceMsg).ok === true, JSON.stringify(ChatCore.validateMessage(userVoiceMsg).errors));
    ok('A3.userVoice.canPlayable', VoiceCore.hasPlayable(userVoiceMsg.voice) === true);
    ok('A3.userVoice.playSrcIsInline', VoiceCore.playSrc(userVoiceMsg.voice) === userVoiceMsg.voice.dataUrl);
    ok('A3.userVoice.notAiVoiceMessage', VoiceCore.isAiVoiceMessage(userVoiceMsg) === false);
    ok('A3.userVoice.toneSurvivesCore', VoiceCore.build(userVoiceMsg.voice).transcript === '你好' && !('tone' in VoiceCore.build(userVoiceMsg.voice)));

    /* A4. 旧三个 provider 仍然注册、仍然可用（回归） */
    const src = read('bridge/tts.js');
    ['edge', 'openai', 'mimo'].forEach(p => ok('A4.registry.' + p + 'Present', new RegExp("^    " + p + ": \\{", 'm').test(src)));
  }

  /* ── A5. 旧 provider 请求 shape 逐字段不变（Edge / OpenAI / MiMo） ── */
  {
    let seen = null;
    const mock = http.createServer((req, res) => {
      let b = ''; req.on('data', c => { b += c; });
      req.on('end', () => {
        seen = { url: req.url, auth: req.headers.authorization || '', apiKey: req.headers['api-key'] || '', body: JSON.parse(b || '{}') };
        if (/audio\/speech/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.from('MP3')); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from('MIMOAUDIO').toString('base64') } } }] }));
      });
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    const port = mock.address().port;
    const cfg = { tts: { enabled: true, endpoint: 'http://127.0.0.1:' + port + '/v1/audio/speech', apiKey: 'oaik', model: 'tts-1', voice: 'alloy', lang: 'zh-CN' }, ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:' + port + '/v1/chat/completions', apiKey: 'mmk' } };
    const t = createTts({ config: cfg, uid: p => p + '_x', ttsDir, ttsVoices: { getRefAudioMeta: () => null } });
    const oa = await t.ttsGenerate('hi', 'echo', 'openai');
    ok('A5.openai.unchangedShape', oa.ok === true && seen.url === '/v1/audio/speech' && seen.auth === 'Bearer oaik' && seen.body.model === 'tts-1' && seen.body.voice === 'echo' && seen.body.response_format === 'mp3' && !('source' in seen.body), JSON.stringify(seen.body));
    const mm = await t.ttsGenerate('你好', 'Chloe', 'mimo');
    ok('A5.mimo.unchangedShape', mm.ok === true && seen.apiKey === 'mmk' && seen.body.messages.length === 1 && seen.body.messages[0].role === 'assistant' && seen.body.audio.voice === 'Chloe' && !('source' in seen.body), JSON.stringify(seen.body));
    /* 新字段 source 不改变旧 provider 的请求体：归一化后 model/voice/rate/pitch 语义一致 */
    const p2 = t.normalizeVoiceProfile({ text: 'x', provider: 'edge', source: 'edge', voiceId: 'zh-CN-YunxiNeural', rate: 1.4, pitch: '+20Hz' });
    ok('A5.sourceDoesNotAlterProviderProfile', p2.provider === 'edge' && p2.voice.id === 'zh-CN-YunxiNeural' && p2.rate === 1.4 && p2.pitch === '+20Hz', JSON.stringify(p2));
    const p3 = t.normalizeVoiceProfile({ text: 'x', source: 'tts', voiceId: 'echo' });
    ok('A5.sourceResolvesToLegacyProviderProfile', p3.provider === 'openai' && p3.voice.id === 'echo' && p3.source === 'tts', JSON.stringify(p3));
    await new Promise(r => mock.close(r));
  }

  /* ── B. Voice API Source：wire payload 与角色记录的 credential 边界 ── */
  {
    const payload = extractFunction('assets/js/bridge.js', '_ibTtsPayload');
    const voiceCfg = { enabled: true, provider: 'voicebox', source: 'voicebox', voiceId: 'prof-uuid-1', model: 'qwen', language: 'zh', style: '轻声', rate: 1, pitch: '+0Hz', voiceType: 'builtin', autoPlay: false };
    const p = payload(voiceCfg, '要念的文本');
    ok('B1.payload.carriesSource', p.source === 'voicebox' && p.provider === 'voicebox', JSON.stringify(p));
    ok('B1.payload.textVerbatim', p.text === '要念的文本');
    ok('B1.payload.noCredentialKeys', VoiceCore.findSecret(p) === '', VoiceCore.findSecret(p));
    ok('B1.payload.noApiKeyKey', !('apiKey' in p) && !('endpoint' in p), Object.keys(p).join(','));
    /* 缺失 source（旧角色）：payload 仍然合法，source 为空串，由 Bridge 按 provider 反推 */
    const legacyPayload = payload({ enabled: true, provider: 'mimo', voiceId: 'Chloe' }, 'x');
    ok('B2.payload.missingSourceIsEmpty', legacyPayload.source === '' && legacyPayload.provider === 'mimo', JSON.stringify(legacyPayload));
    /* 恶意/脏数据：即使角色记录被手改成带密钥，payload 也不会把它带出去 */
    const dirty = payload({ provider: 'openai', apiKey: 'sk-should-never-travel', voiceId: 'alloy' }, 'x');
    ok('B3.payload.dropsForeignSecret', VoiceCore.findSecret(dirty) === '' && JSON.stringify(dirty).indexOf('sk-should-never-travel') === -1, JSON.stringify(dirty));

    /* B4. endpoint 覆盖：运行期只认 Bridge config（角色记录里的 endpoint 不参与） */
    const cfgOverride = { voicebox: { enabled: true, endpoint: 'http://127.0.0.1:17777' } };
    const vb = createVoicebox({ config: cfgOverride });
    ok('B4.endpoint.fromBridgeConfig', vb.endpoint() === 'http://127.0.0.1:17777');
    const tOverride = createTts({ config: Object.assign({}, cfgOverride, { tts: {}, ttsMimo: {} }), uid: p => p, ttsDir, ttsVoices: { getRefAudioMeta: () => null }, voicebox: vb });
    const prof = tOverride.normalizeVoiceProfile({ text: 'x', source: 'voicebox', voiceId: 'p', endpoint: 'http://evil.example.com' });
    ok('B4.endpoint.characterRecordCannotOverride', prof.provider === 'voicebox' && !('endpoint' in prof), JSON.stringify(prof));

    /* B5. 角色保存路径：写出的 voice 对象只含非秘密字段（源码级 + 行为级双证） */
    const social = read('assets/js/social.js');
    const saveBlock = (social.match(/return Object\.assign\(\{\},_pv,\{[\s\S]*?\n      \}\)/) || [''])[0];
    ok('B5.save.blockFound', saveBlock.length > 0);
    /* 注释可以提到 apiKey（说明「凭据不在这里」）；断言的是**代码**里没有 credential 字段。 */
    const saveCode = saveBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok('B5.save.noCredentialField', !/apiKey|token|secret|authorization/i.test(saveCode), saveCode.slice(0, 300));
    ok('B5.save.writesSource', /source:/.test(saveCode), saveCode.slice(0, 300));
    /* 角色的 voice 记录里没有任何 credential —— 用同一个秘密探针扫一遍典型记录 */
    const charRecord = { id: 'friend_1', provider: 'openai', apiKey: 'sk-real-key-1234567890', model: 'gpt-4o', nickname: 'X', voice: { enabled: true, provider: 'voicebox', source: 'voicebox', voiceId: 'prof-uuid-1', voiceType: 'builtin', voiceData: null } };
    ok('B6.characterRecord.secretIsOutsideVoice', VoiceCore.findSecret(charRecord.voice) === '', VoiceCore.findSecret(charRecord.voice));
    ok('B6.characterRecord.detectsKeyAtRoot', VoiceCore.findSecret(charRecord) === 'apiKey', VoiceCore.findSecret(charRecord));
  }

  /* ── C. Security：apiKey 不进入 chatMessages / voice metadata / 导出 ── */
  {
    /* C1. 生产写入点：任何 chatMessages 写入的 voice 载荷都不含 credential */
    const writers = [
      ['communication.js', /userMsg\.voice=\{([^}]*)\}/g],
      ['social.js', /userMsg\.voice=\{([^}]*)\}/g]
    ];
    let bad = '';
    writers.forEach(([f, re]) => {
      const t = read('assets/js/' + f);
      let m;
      while ((m = re.exec(t))) { if (/apiKey|token|secret|authorization/i.test(m[1])) bad += f + ' '; }
    });
    ok('C1.messageWriters.noCredentialInVoice', bad === '', bad);

    /* C2. assistant voice 写入路径（bridge.js）也只写白名单 provenance */
    const bridgeSrc = read('assets/js/bridge.js');
    const persist = bridgeSrc.match(/async function _ibPersistAiVoice\([\s\S]*?\n\}/);
    ok('C2.persist.found', !!persist);
    ok('C2.persist.noCredentialLiteral', persist && !/apiKey|authorization|Bearer/i.test(persist[0]), persist && persist[0].slice(0, 200));
    ok('C2.persist.usesWhitelistBuilder', persist && /core\.build\(/.test(persist[0]));
    ok('C2.persist.onlyOnSuccess', /if\(j&&j\.ok\)\{[\s\S]{0,400}_ibPersistAiVoice\(bubble,j,text\)/.test(bridgeSrc));

    /* C3. 一条完整 canonical assistant voice message 通过秘密探针 + 导出后仍无秘密 */
    const msg = {
      id: 'msg_1700000000002_7', role: 'assistant', content: '今晚早点睡。', friendId: 'friend_1', timestamp: 1700000000002,
      metadata: { model: 'gpt-4o', model_id: 'gpt-4o', config_id: 'friend_1' },
      voice: VoiceCore.build({
        dataUrl: 'data:audio/wav;base64,' + Buffer.from('RIFFfakeaudio').toString('base64'),
        audioUrl: '/tts/tts_abc.wav', mime: 'audio/wav', duration: 2.5, transcript: '今晚早点睡。',
        provenance: { source: 'voicebox', provider: 'voicebox', engine: 'qwen', model: '', voiceId: 'prof-uuid-1', voiceType: 'builtin', apiKey: 'sk-leak', token: 'leak' }
      })
    };
    ok('C3.message.validateOk', ChatCore.validateMessage(msg).ok === true, JSON.stringify(ChatCore.validateMessage(msg).errors));
    ok('C3.message.noSecretAfterBuild', VoiceCore.findSecret(msg) === '', VoiceCore.findSecret(msg));
    ok('C3.message.provenanceDroppedSecrets', !('apiKey' in (msg.voice.provenance || {})) && !('token' in (msg.voice.provenance || {})), JSON.stringify(msg.voice.provenance));
    const exported = JSON.parse(JSON.stringify({ version: 9, chatMessages: [msg] }));
    ok('C3.export.noSecret', VoiceCore.findSecret(exported) === '' && JSON.stringify(exported).indexOf('sk-leak') === -1);

    /* C4. 源码级：Bridge 侧不把 apiKey/endpoint 写进 /api/tts 响应 */
    const ttsSrc = read('bridge/tts.js');
    ok('C4.bridge.sourcesNoKey', !/listVoiceSources[\s\S]{0,2000}apiKey\s*:/.test(ttsSrc));
    const routeSrc = read('bridge/routes.js');
    const srcRoute = routeSrc.match(/if \(pathname === '\/api\/tts\/sources'[\s\S]*?\n    \}/);
    ok('C4.route.sourcesFound', !!srcRoute);
    ok('C4.route.sourcesNoKeyField', srcRoute && !/apiKey|token/i.test(srcRoute[0]), srcRoute && srcRoute[0].slice(0, 200));

    /* C5. config 脱敏面仍把 tts / ttsMimo / voiceAsr 的密钥掩码（回归） */
    const cfg = { tts: { apiKey: 'k1' }, ttsMimo: { apiKey: 'k2' }, voiceAsr: { apiKey: 'k3' }, voicebox: { enabled: true, endpoint: 'http://127.0.0.1:17493' } };
    const vb = createVoicebox({ config: cfg });
    const health = await vb.health().catch(e => ({ ok: false, error: String(e) }));
    ok('C5.voiceboxHasNoKeyToLeak', !('apiKey' in cfg.voicebox) && health.ok === false);
    ok('C5.voiceboxHealthErrorHasNoSecret', String(health.error || '').indexOf('k1') === -1 && String(health.error || '').indexOf('k3') === -1);
  }

  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
  try { fs.rmSync(ttsDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

main().catch(e => { console.error('test_voice_source fatal:', e && e.stack || e); process.exit(1); });
