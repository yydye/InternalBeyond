'use strict';

/* Internal Beyond · VoiceClone Reference Audio 专项测试（第三阶段 B1）。
 * 零依赖：先直接驱动 bridge/tts-voices.js（magic bytes / 校验 / 注册表 / 文件语义），
 * 再对真实 ib-bridge-service.js 实例走 HTTP（上传 / 读取 / 删除 / 路径穿越 / 持久化）。
 * 覆盖：MP3/WAV 上传、10 MB 上限、空文件、错误格式、MIME 伪造、扩展名不一致、
 *       Path Traversal、GET/DELETE 语义、引用拒绝、重启持久化、导出无二进制（前端校验在 UI 回归）。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const BRIDGE = path.join(__dirname, 'ib-bridge-service.js');
const createTtsVoices = require('./bridge/tts-voices');

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 240) : '')); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ── 测试音频样本 ── */
function mp3Id3(extra) {
  /* ID3v2 头 + 填充字节 */
  const head = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, Buffer.from(extra || [1, 2, 3, 4, 5, 6, 7, 8])]);
}
function mp3Frame(extra) {
  /* MPEG1 Layer III 帧同步：0xFF 0xFB … */
  return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00]), Buffer.from(extra || [1, 2, 3])]);
}
function wav(extra) {
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVE'), Buffer.from(extra || [1, 2, 3, 4])]);
}

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
let usedPorts = new Set();
function freePort() {
  for (let i = 0; i < 50; i++) {
    const p = 24000 + Math.floor(Math.random() * 1000);
    if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
  }
  throw new Error('测试端口用尽');
}
async function waitHealth(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) return true; } catch (e) { /* 未就绪 */ }
    await sleep(200);
  }
  return false;
}
async function startBridge(dataDir, port) {
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { IB_BRIDGE_PORT: String(port), IB_BRIDGE_HOST: '127.0.0.1', IB_BRIDGE_DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  if (!await waitHealth(port, 10000)) { child.kill(); throw new Error('bridge not healthy on ' + port); }
  return child;
}

/* chunked 上传（无 Content-Length）：模拟流式大 body，验证读取阶段的硬上限 */
function chunkedPost(port, url, buffer, headers) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: url, method: 'POST',
      headers: Object.assign({}, headers || {})
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { /* 忽略 */ }
        resolve({ status: res.statusCode, json: parsed });
      });
    });
    req.on('error', e => resolve({ error: String(e && e.message || e) }));
    /* 不设 content-length → Node 自动 chunked */
    req.write(buffer);
    req.end();
    setTimeout(() => { try { req.destroy(); } catch (e) { /* 忽略 */ } }, 15000);
  });
}

/* 直接驱动模块：detect / validate / 注册表 / 文件语义 */
async function moduleTests() {
  console.log('── A. 模块层（bridge/tts-voices.js）──');
  const dir = tmpDir('ib-voice-unit-');
  const module = createTtsVoices({ dataDir: dir, writeJson: (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); return true; } catch (e) { return false; } }, loadJson: (n, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n + '.json'), 'utf8')); } catch (e) { return fb; } } });
  try {
    /* magic bytes */
    ok('A.magic.mp3Id3', module.detectAudioKind(mp3Id3()) === 'mp3');
    ok('A.magic.mp3Frame', module.detectAudioKind(mp3Frame()) === 'mp3');
    ok('A.magic.wav', module.detectAudioKind(wav()) === 'wav');
    ok('A.magic.garbage', module.detectAudioKind(Buffer.from('hello world, not audio data')) === null);
    ok('A.magic.short', module.detectAudioKind(Buffer.from([1, 2, 3])) === null);

    /* validateUpload 三方校验 */
    ok('A.validate.mp3Ok', module.validateUpload(mp3Id3(), 'audio/mpeg', 'voice.mp3').ok === true);
    ok('A.validate.wavOk', module.validateUpload(wav(), 'audio/wav', 'voice.wav').ok === true);
    ok('A.validate.empty', module.validateUpload(Buffer.alloc(0), 'audio/mpeg', 'x.mp3').ok === false);
    const big = Buffer.concat([mp3Id3(), Buffer.alloc(10 * 1024 * 1024)]);
    ok('A.validate.tooLarge', module.validateUpload(big, 'audio/mpeg', 'x.mp3').ok === false);
    ok('A.validate.textFormat', module.validateUpload(Buffer.from('this is not audio'), 'audio/mpeg', 'x.mp3').ok === false);
    ok('A.validate.mimeSpoof', module.validateUpload(wav(), 'audio/mpeg', 'x.wav').ok === false);
    ok('A.validate.extMismatch', module.validateUpload(mp3Id3(), 'audio/mpeg', 'x.wav').ok === false);
    ok('A.validate.unknownCt', module.validateUpload(mp3Id3(), 'image/png', 'x.mp3').ok === false);
    ok('A.validate.noCtNoName', module.validateUpload(mp3Frame(), '', '').ok === true);
    ok('A.validate.octetStream', module.validateUpload(mp3Frame(), 'application/octet-stream', '').ok === true);
    ok('A.validate.nameNoExt', module.validateUpload(mp3Id3(), 'audio/mpeg', 'recording').ok === true);

    /* saveRefAudio：文件名 = <refAudioId>.<ext>，原始文件名只进 metadata */
    const saved1 = module.saveRefAudio({ buf: mp3Id3(), contentType: 'audio/mpeg', originalName: '../../etc/passwd.mp3' });
    ok('A.save.mp3Meta', saved1.ok === true && saved1.voice.refAudioId && /^[A-Za-z0-9_-]{8,64}$/.test(saved1.voice.refAudioId)
      && saved1.voice.mime === 'audio/mpeg' && saved1.voice.ext === 'mp3' && saved1.voice.size > 0, JSON.stringify(saved1));
    const file1 = path.join(module.voicesDir, saved1.voice.refAudioId + '.mp3');
    ok('A.save.fileOnDisk', fs.existsSync(file1) && fs.readFileSync(file1).equals(mp3Id3()));
    ok('A.save.originalNameMetadataOnly', saved1.voice.originalName === 'passwd.mp3' && path.basename(file1) !== 'passwd.mp3');
    const saved2 = module.saveRefAudio({ buf: wav(), contentType: 'audio/wav', originalName: '录音.wav' });
    ok('A.save.wavMeta', saved2.ok === true && saved2.voice.ext === 'wav');
    ok('A.save.idsUnique', saved1.voice.refAudioId !== saved2.voice.refAudioId);

    /* resolve：只认注册表，不认输入路径 */
    ok('A.resolve.ok', !!module.resolveRefAudio(saved1.voice.refAudioId));
    ok('A.resolve.missing', module.resolveRefAudio('nonexistent12345') === null);
    ok('A.resolve.traversal', module.resolveRefAudio('../../config.json') === null);
    /* delete 未引用 → ok；再 resolve → null */
    const del1 = module.deleteRefAudio(saved2.voice.refAudioId);
    ok('A.delete.ok', del1.ok === true && fs.existsSync(path.join(module.voicesDir, saved2.voice.refAudioId + '.wav')) === false);
    ok('A.delete.missing', module.deleteRefAudio(saved2.voice.refAudioId).ok === false);

    /* 诊断：磁盘↔注册表对账 */
    fs.writeFileSync(path.join(module.voicesDir, 'stray-file.bin'), 'x');
    const diag = module.listReferencedVoiceAssets();
    ok('A.diag.orphan', diag.orphanFiles.indexOf('stray-file.bin') !== -1 && diag.missingFiles.length === 0, JSON.stringify(diag));
    fs.unlinkSync(file1);
    const diag2 = module.listReferencedVoiceAssets();
    ok('A.diag.missing', diag2.missingFiles.some(m => m === saved1.voice.refAudioId + '.mp3'), JSON.stringify(diag2.missingFiles));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/* 真实 Bridge HTTP 层 */
async function httpTests() {
  console.log('── B. HTTP 层（真实 Bridge 实例）──');
  const dataDir = tmpDir('ib-voice-http-');
  const port = freePort();
  const base = 'http://127.0.0.1:' + port;
  let bridge = await startBridge(dataDir, port);
  try {
    /* 1. MP3 上传 */
    const upMp3 = await fetch(base + '/api/tts/voices?name=' + encodeURIComponent('voice.mp3'), {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: mp3Id3([9, 9, 9])
    }).then(r => r.json());
    ok('B.mp3.upload', upMp3.ok === true && upMp3.voice && upMp3.voice.refAudioId && upMp3.voice.mime === 'audio/mpeg' && upMp3.voice.ext === 'mp3' && upMp3.voice.originalName === 'voice.mp3', JSON.stringify(upMp3));
    const mp3Id = upMp3.voice.refAudioId;

    /* 2. WAV 上传 */
    const upWav = await fetch(base + '/api/tts/voices?name=' + encodeURIComponent('voice.wav'), {
      method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav()
    }).then(r => r.json());
    ok('B.wav.upload', upWav.ok === true && upWav.voice.ext === 'wav' && upWav.voice.refAudioId !== mp3Id, JSON.stringify(upWav));
    const wavId = upWav.voice.refAudioId;

    /* 3. 磁盘布局：tts-voices/<id>.<ext>，不用原始文件名，不放在 TTS 输出目录 */
    const dirNames = fs.readdirSync(path.join(dataDir, 'tts-voices'));
    ok('B.storage.layout', dirNames.indexOf(mp3Id + '.mp3') !== -1 && dirNames.indexOf(wavId + '.wav') !== -1
      && dirNames.indexOf('voice.mp3') === -1 && fs.existsSync(path.join(dataDir, mp3Id + '.mp3')) === false);

    /* 4. 超过 10 MB：Content-Length 预检（入口拒绝，不读取 body） */
    const bigPre = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/tts/voices?name=big.mp3', method: 'POST',
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(11 * 1024 * 1024) }
      }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', e => resolve({ error: String(e && e.message || e) }));
      req.write(mp3Id3());
      req.end();
      setTimeout(() => { try { req.destroy(); } catch (e) { /* 忽略 */ } }, 10000);
    });
    ok('B.size.precheck', bigPre.status === 413, JSON.stringify(bigPre));
    /* 5. 超过 10 MB：流式读取阶段拒绝（无 Content-Length，chunked） */
    const bigChunk = await chunkedPost(port, '/api/tts/voices?name=big.mp3', Buffer.concat([mp3Id3(), Buffer.alloc(10 * 1024 * 1024)]), { 'Content-Type': 'audio/mpeg' });
    ok('B.size.stream', (bigChunk.status === 413 || bigChunk.status === 400 || !!bigChunk.error), JSON.stringify(bigChunk));

    /* 6. 空文件 */
    const empty = await fetch(base + '/api/tts/voices?name=e.mp3', { method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.alloc(0) });
    ok('B.empty.rejected', empty.status === 400 && (await empty.json()).ok === false);

    /* 7. 错误格式 */
    const badFmt = await fetch(base + '/api/tts/voices?name=x.mp3', {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: Buffer.from('plain text pretending to be audio')
    });
    const badFmtJ = await badFmt.json();
    ok('B.format.rejected', badFmt.status === 400 && badFmtJ.ok === false && /unsupported audio format/.test(badFmtJ.error), badFmtJ.error);

    /* 8. MIME 伪造（WAV 字节 + audio/mpeg）；扩展名不一致（MP3 字节 + .wav） */
    const spoof = await fetch(base + '/api/tts/voices?name=spoof.mp3', {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: wav()
    });
    const spoofJ = await spoof.json();
    ok('B.mimeSpoof.rejected', spoof.status === 400 && /content type mismatch/.test(spoofJ.error), spoofJ.error);
    const extBad = await fetch(base + '/api/tts/voices?name=bad.wav', {
      method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: mp3Id3()
    });
    const extBadJ = await extBad.json();
    ok('B.extMismatch.rejected', extBad.status === 400 && /filename extension mismatch/.test(extBadJ.error), extBadJ.error);

    /* 9. Path Traversal / 任意读取：全部 4xx，绝不 200 */
    const traversalPaths = [
      '..%2F..%2Fconfig.json', '..%2F..%2Ftts-voices.json',
      '..%5C..%5Cconfig.json',
      '%2Fabsolute%2Fpath.mp3',
      'C%3A%5CWindows%5Cwin.ini',
      '..%2Ftts-voices%2F' + mp3Id + '.mp3',
      '%2e%2e%2f%2e%2e%2fconfig.json'
    ];
    let allRejected = true, badStatus = '';
    for (const p of traversalPaths) {
      const res = await fetch(base + '/api/tts/voices/' + p);
      if (res.status >= 200 && res.status < 300) { allRejected = false; badStatus = p + '=' + res.status; break; }
      if (res.ok) { allRejected = false; badStatus = p + '=ok'; break; }
    }
    ok('B.traversal.encodedIds', allRejected, badStatus);
    /* 未编码的真实斜杠：路由根本不匹配 → 404 */
    const rawTraversal = await fetch(base + '/api/tts/voices/../../config.json');
    ok('B.traversal.rawSlashes', rawTraversal.status === 404, 'status=' + rawTraversal.status);
    /* DELETE 上的穿越同样拒绝 */
    const delTraversal = await fetch(base + '/api/tts/voices/..%2F..%2Fconfig.json', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok('B.traversal.delete', delTraversal.status === 404);

    /* 10. GET 合法 id → 完整字节；HEAD → 头部无体 */
    const got = await fetch(base + '/api/tts/voices/' + encodeURIComponent(mp3Id));
    const gotBuf = Buffer.from(await got.arrayBuffer());
    ok('B.get.ok', got.status === 200 && /audio\/mpeg/.test(got.headers.get('content-type') || '') && gotBuf.equals(mp3Id3([9, 9, 9])));
    const head = await fetch(base + '/api/tts/voices/' + encodeURIComponent(wavId), { method: 'HEAD' });
    ok('B.head.ok', head.status === 200 && /audio\/wav/.test(head.headers.get('content-type') || '') && Number(head.headers.get('content-length')) > 0);

    /* 11. GET 不存在 id → 404 明确错误；非法字符集 id → 404 */
    const missing = await fetch(base + '/api/tts/voices/nonexistent12345');
    const missingJ = await missing.json();
    ok('B.get.missing', missing.status === 404 && missingJ.ok === false && /不存在/.test(missingJ.error), missingJ.error);

    /* 12. DELETE：仍被角色引用 → 409（明确错误）；未引用 → 200 且文件消失 */
    const delRef = await fetch(base + '/api/tts/voices/' + encodeURIComponent(mp3Id), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referencedIds: [mp3Id] })
    });
    const delRefJ = await delRef.json();
    ok('B.delete.referencedRejected', delRef.status === 409 && delRefJ.ok === false && /引用/.test(delRefJ.error), delRefJ.error);
    ok('B.delete.referencedFileSurvives', fs.existsSync(path.join(dataDir, 'tts-voices', mp3Id + '.mp3')));
    const delFree = await fetch(base + '/api/tts/voices/' + encodeURIComponent(wavId), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ referencedIds: [] })
    });
    const delFreeJ = await delFree.json();
    ok('B.delete.unreferenced', delFree.status === 200 && delFreeJ.ok === true && delFreeJ.removed && delFreeJ.removed.refAudioId === wavId, JSON.stringify(delFreeJ));
    const afterDel = await fetch(base + '/api/tts/voices/' + encodeURIComponent(wavId));
    ok('B.delete.fileGoneFromGet', afterDel.status === 404);
    ok('B.delete.fileGoneFromDisk', !fs.existsSync(path.join(dataDir, 'tts-voices', wavId + '.wav')));

    /* 13. 列表 + 诊断（只读）：注册表 ↔ 磁盘对账 */
    const stray = path.join(dataDir, 'tts-voices', 'manual-orphan.mp3');
    fs.writeFileSync(stray, 'not registered');
    const list = await (await fetch(base + '/api/tts/voices')).json();
    ok('B.list.ok', list.ok === true && Array.isArray(list.voices) && list.voices.some(v => v.refAudioId === mp3Id)
      && list.diagnostics && list.diagnostics.orphanFiles.indexOf('manual-orphan.mp3') !== -1, JSON.stringify(list.diagnostics));
    fs.unlinkSync(stray);
    /* 注册表不存二进制（内容为纯 JSON 元数据） */
    const metaRaw = fs.readFileSync(path.join(dataDir, 'tts-voices.json'), 'utf8');
    const metaJson = JSON.parse(metaRaw);
    ok('B.registry.metadataOnly', metaJson.assets && metaJson.assets[mp3Id] && metaJson.assets[mp3Id].mime === 'audio/mpeg'
      && !/data:|base64|PD94|RIFF/.test(metaRaw) && metaRaw.indexOf(mp3Id) !== -1);

    /* 14. 重启持久化：文件 + 注册表 + GET 全部存活 */
    bridge.kill();
    await sleep(300);
    bridge = await startBridge(dataDir, port);
    const got2 = await fetch(base + '/api/tts/voices/' + encodeURIComponent(mp3Id));
    ok('B.restart.fileServed', got2.status === 200 && Buffer.from(await got2.arrayBuffer()).equals(mp3Id3([9, 9, 9])));
    const list2 = await (await fetch(base + '/api/tts/voices')).json();
    ok('B.restart.registrySurvives', list2.ok === true && list2.voices.some(v => v.refAudioId === mp3Id && v.exists === true));

    /* 15. 诊断端点带 voiceAssets */
    const diag = await (await fetch(base + '/api/diagnostics')).json();
    ok('B.diagnostics.voiceAssets', diag.ok === true && diag.voiceAssets && diag.voiceAssets.assets >= 1 && typeof diag.voiceAssets.bytes === 'number', JSON.stringify(diag.voiceAssets));
  } finally {
    bridge.kill();
    await sleep(300);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

async function main() {
  console.log('== Internal Beyond · VoiceClone Reference Audio 测试 ==');
  await moduleTests();
  await httpTests();
  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')' : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main().catch(e => { console.error('test_tts_voices fatal:', e && e.stack || e); process.exit(1); });
