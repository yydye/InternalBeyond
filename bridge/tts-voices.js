/* IB Bridge · VoiceClone Reference Audio 文件基础设施（第三阶段 B1）。
   独立资产层：上传 → 严格校验（Content-Type / 扩展名 / magic bytes 三方一致）
   → 生成密码学安全 refAudioId → 落盘 DATA_DIR/tts-voices/<refAudioId>.<ext>
   → 服务端 metadata 注册表（DATA_DIR/tts-voices.json）。
   Reference Audio 二进制绝不进入 IndexedDB / 导出 JSON；角色 voice.voiceData.refAudioId
   只是对服务端文件的一个引用。
   本阶段仅做文件基础设施：不实现 MiMo VoiceClone API，不上行任何合成请求。 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VOICES_DIR_NAME = 'tts-voices';
const REGISTRY_FILE_NAME = 'tts-voices'; /* DATA_DIR/tts-voices.json（与其它业务 JSON 同形） */
const MAX_REF_AUDIO_BYTES = 10 * 1024 * 1024; /* 10 MB 上限 */
/* refAudioId 白名单字符集：只允许 URL-safe base64 风格字符，长度 8–64。
   服务端路径只由「注册表 metadata 里的 ext」拼装，绝不使用用户输入。 */
const REF_AUDIO_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ORIGINAL_NAME_LEN = 120;

/* ── MIME 归一化：官方只允许 mp3 / wav ── */
const MIME_KINDS = [
  { kind: 'mp3', mime: 'audio/mpeg', exts: ['mp3'], cts: ['audio/mpeg', 'audio/mp3', 'audio/x-mp3', 'application/octet-stream'] },
  { kind: 'wav', mime: 'audio/wav', exts: ['wav'], cts: ['audio/wav', 'audio/x-wav', 'audio/wave', 'application/octet-stream'] }
];

function normalizeMimeType(contentType) {
  const raw = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!raw) return null;
  for (const k of MIME_KINDS) {
    if (k.cts.indexOf(raw) !== -1) return { kind: k.kind, mime: k.mime, ext: k.exts[0] };
  }
  return null; /* 未知 / 非音频类型 */
}

/* ── magic-byte 检测（不信任浏览器 MIME）──
   MP3：ID3v2 标签头（"ID3"），或 MPEG 帧同步字 0xFF 0xE0+（版本位非保留、层位非保留）。
   WAV：RIFF....WAVE。 */
function detectAudioKind(buf) {
  if (!buf || buf.length < 2) return null;
  /* MP3 ID3v2：标签头 3 字节 'ID3'；ID3v1 在尾部无特征可判，统一按帧同步兜底 */
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  /* MPEG 帧同步：11 位全 1（0xFF + byte1 高 3 位）；版本位 != 保留(01)；层位 != 保留(00) */
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x18) !== 0x08 && (buf[1] & 0x06) !== 0x00) return 'mp3';
  /* RIFF/WAVE：'RIFF' + 4 字节长度 + 'WAVE' */
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) return 'wav';
  return null;
}

/* 原始文件名只作为 metadata：剥离一切路径成分（/ 或 \ 都视为分隔符），
   去控制字符，截断长度；空值回落为 'audio'。绝不能再用于磁盘路径。 */
function sanitizeOriginalName(name) {
  let s = String(name == null ? '' : name);
  s = s.split(/[\\/]/).pop() || '';
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_ORIGINAL_NAME_LEN);
  return s;
}

function extOfName(name) {
  const base = sanitizeOriginalName(name);
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return m ? m[1].toLowerCase() : '';
}

function createTtsVoices(deps) {
  const dataDir = deps.dataDir;
  const writeJson = deps.writeJson;   /* (file, obj) -> bool */
  const loadJson = deps.loadJson;     /* (name, fallback) -> object */
  const voicesDir = path.join(dataDir, VOICES_DIR_NAME);

  fs.mkdirSync(voicesDir, { recursive: true });

  /* 服务端 metadata 注册表：refAudioId → { refAudioId, mime, ext, size, originalName, created }
     文件路径一律由 注册表.ext 生成，禁止接受任何外部路径输入。 */
  let registry = { version: 1, assets: {} };
  const loaded = loadJson(REGISTRY_FILE_NAME, null);
  if (loaded && typeof loaded === 'object' && loaded.assets && typeof loaded.assets === 'object') {
    registry = { version: 1, assets: loaded.assets };
  }

  function persistRegistry() {
    if (!writeJson(path.join(dataDir, REGISTRY_FILE_NAME + '.json'), registry)) {
      console.error('[IB Bridge] Reference Audio 注册表写入失败：' + path.join(dataDir, REGISTRY_FILE_NAME + '.json'));
      return false;
    }
    return true;
  }

  function newRefAudioId() {
    for (;;) {
      /* 密码学安全随机 ID：9 字节 → 12 字符 base64url，无填充、无易混淆字符集外字符 */
      const id = crypto.randomBytes(9).toString('base64url');
      if (REF_AUDIO_ID_RE.test(id) && !registry.assets[id]) return id;
    }
  }

  function isValidRefAudioId(id) {
    return typeof id === 'string' && REF_AUDIO_ID_RE.test(id);
  }

  function getRefAudioMeta(id) {
    if (!isValidRefAudioId(id)) return null;
    return registry.assets[id] || null;
  }

  /* 唯一文件解析入口：refAudioId + 服务端 metadata。返回 null 即 404。
     任何情况下都不把输入字符串拼进路径。 */
  function resolveRefAudio(id) {
    const meta = getRefAudioMeta(id);
    if (!meta) return null;
    const file = path.join(voicesDir, id + '.' + meta.ext);
    if (!file.startsWith(voicesDir + path.sep)) return null;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return { file, meta };
  }

  /* 三方校验：Content-Type + 扩展名 + 文件头，全部一致才接受 */
  function validateUpload(buf, contentType, originalName) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return { ok: false, error: 'empty audio' };
    if (buf.length > MAX_REF_AUDIO_BYTES) return { ok: false, error: 'audio too large' };
    const kind = detectAudioKind(buf);
    if (!kind) return { ok: false, error: 'unsupported audio format (only MP3 / WAV)' };

    const ct = normalizeMimeType(contentType);
    /* Content-Type 明确提供时必须是合法音频类型且与内容一致；缺省时以文件头为准 */
    if (contentType && !ct) return { ok: false, error: 'unsupported content type: ' + String(contentType).slice(0, 60) };
    if (ct && ct.kind !== kind) return { ok: false, error: 'content type mismatch: ' + ct.kind + ' declared but ' + kind + ' detected' };

    /* 扩展名：提供时（且带扩展名）必须与内容一致；无扩展名则按检测结果 */
    const extFromName = extOfName(originalName);
    if (extFromName && extFromName !== kind) {
      return { ok: false, error: 'filename extension mismatch: .' + extFromName + ' declared but ' + kind + ' detected' };
    }
    const k = MIME_KINDS.find(x => x.kind === kind);
    return {
      ok: true,
      mime: k.mime,
      ext: k.exts[0],
      size: buf.length,
      originalName: sanitizeOriginalName(originalName) || ('audio.' + k.exts[0])
    };
  }

  /* 保存：先写文件（崩溃只留下可诊断的孤儿文件），再注册 metadata（注册表持久化失败则回滚删文件）。 */
  function saveRefAudio(upload) {
    const v = validateUpload(upload.buf, upload.contentType, upload.originalName);
    if (!v.ok) return v;
    const id = newRefAudioId();
    const file = path.join(voicesDir, id + '.' + v.ext);
    try {
      fs.writeFileSync(file, upload.buf);
    } catch (e) {
      return { ok: false, error: 'write failed' };
    }
    const meta = { refAudioId: id, mime: v.mime, ext: v.ext, size: v.size, originalName: v.originalName, created: Date.now() };
    registry.assets[id] = meta;
    if (!persistRegistry()) {
      try { fs.unlinkSync(file); } catch (e) { /* 忽略 */ }
      delete registry.assets[id];
      return { ok: false, error: 'registry save failed' };
    }
    return { ok: true, voice: { refAudioId: id, mime: meta.mime, ext: meta.ext, size: meta.size, originalName: meta.originalName } };
  }

  /* 删除（引用检查由路由层基于前端声明的 referencedIds 执行后才调用本函数） */
  function deleteRefAudio(id) {
    const meta = getRefAudioMeta(id);
    if (!meta) return { ok: false, error: 'not found' };
    const file = path.join(voicesDir, id + '.' + meta.ext);
    delete registry.assets[id];
    const persisted = persistRegistry();
    let fileGone = true;
    try { fs.unlinkSync(file); } catch (e) { fileGone = false; }
    /* 注册表持久化失败时文件仍被删除：下次启动会显示 missingFiles 诊断告警，不会复活旧内容 */
    if (!persisted) console.error('[IB Bridge] Reference Audio 删除后注册表持久化失败：' + id);
    return { ok: true, removed: { refAudioId: id, size: meta.size, fileGone } };
  }

  function listRefAudioAssets() {
    return Object.keys(registry.assets)
      .map(id => Object.assign({ exists: false }, registry.assets[id]))
      .map(a => {
        try { a.exists = fs.existsSync(path.join(voicesDir, a.refAudioId + '.' + a.ext)); } catch (e) { a.exists = false; }
        return a;
      })
      .sort((x, y) => (y.created || 0) - (x.created || 0));
  }

  /* 诊断：磁盘 ↔ 注册表对账。orphanFiles = 磁盘存在但无 metadata；
     missingFiles = 有 metadata 但磁盘文件缺失。自动删除属于后续维护功能，本阶段不删。 */
  function listReferencedVoiceAssets() {
    const assets = listRefAudioAssets();
    const diskFiles = new Set();
    let orphanFiles = [];
    try {
      fs.readdirSync(voicesDir).forEach(name => {
        const m = /^([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9]{1,8})$/.exec(name);
        if (!m) { orphanFiles.push(name); return; }
        diskFiles.add(m[1]);
        if (!registry.assets[m[1]]) orphanFiles.push(name);
      });
    } catch (e) { /* 目录不可读时仅返回注册表视图 */ }
    const missingFiles = assets.filter(a => !a.exists).map(a => a.refAudioId + '.' + a.ext);
    return { assets, orphanFiles: orphanFiles.sort(), missingFiles };
  }

  return {
    newRefAudioId,
    detectAudioKind,
    normalizeMimeType,
    sanitizeOriginalName,
    validateUpload,
    saveRefAudio,
    getRefAudioMeta,
    resolveRefAudio,
    deleteRefAudio,
    listRefAudioAssets,
    listReferencedVoiceAssets,
    voicesDir,
    maxBytes: MAX_REF_AUDIO_BYTES
  };
}

module.exports = createTtsVoices;
