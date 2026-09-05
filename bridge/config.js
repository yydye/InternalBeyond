/* IB Bridge · 配置加载、校验、升级与鉴权辅助。
   从 ib-bridge-service.js 提取为工厂：全部可变状态（config / configRaw / LAN_EXPOSED）
   收在 createConfig 闭包内，避免多模块共享全局。持久化通过注入的 writeJson(file, obj)
   完成（由 composition root 提供），避免循环依赖。原逻辑逐字不变。 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { deepMerge, constantTimeTokenMatch } = require('./util');

function createConfig(deps) {
  const dataDir = deps.dataDir;
  const writeJson = deps.writeJson;

  function jsonPath(name) {
    return path.join(dataDir, name + '.json');
  }

  function defaultConfig() {
    return {
      version: 1,
      token: '',                     // 留空 = 仅本机、不鉴权；设置后 IBNET 需要填写相同 token
      contextBudget: 200000,         // 上下文估算预算（token），进度条按此计算
      lan: false,                    // true = 监听 0.0.0.0，方便 OPPO/Android 手机访问（注意放行防火墙）
      music: {                       // 点歌：默认酷狗（你会员在酷狗）；可切 netease
        provider: 'kugou',
        kugouCookie: '',             // 可选：浏览器里登录酷狗后复制的 Cookie，会员歌/高品质更稳
        fallbackNetease: true        // 酷狗拿不到播放地址时，按歌名自动切网易云兜底
      },
      tts: {                         // AI 语音气泡：OpenAI 兼容 TTS 接口
        enabled: false,
        endpoint: 'https://api.openai.com/v1/audio/speech',
        apiKey: '',
        model: 'tts-1',
        voice: 'alloy',
        lang: 'zh-CN'
      },
      ttsMimo: {                     // AI 语音气泡：MiMo TTS（OpenAI chat-completions 兼容；文本在 assistant 消息）
        enabled: false,
        endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
        apiKey: '',
        voice: ''                    // 留空时按角色 voiceId，再兜底注册表默认（mimo_default）
      },
      voiceAsr: {                    // 语音通话 ASR：OpenAI-compatible /audio/transcriptions
        enabled: false,
        endpoint: 'https://api.openai.com/v1/audio/transcriptions',
        apiKey: '',                  // 仅保存在 Bridge；绝不发送到浏览器
        model: 'whisper-1',
        language: 'zh',
        timeoutMs: 60000,
        maxTurnSeconds: 60
      },
      bark: { enabled: false, url: '' },   // 例：https://api.day.app/你的Key
      ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '' },  // Android/OPPO 推荐
      webhooks: {},                  // { 名称: { url, method, headers, confirm } }
      proactive: {                   // 可选：本地低频主动消息（默认关闭）
        enabled: false,
        intervalMin: 50,
        endpoint: '',
        apiKey: '',
        model: '',
        system: '你是陪伴者，发一条简短、自然、像真人一样主动发来的消息。',
        prompt: '现在主动给用户发一条消息（50 字以内，不要加任何前缀或解释）。',
        from: 'Sui'
      }
    };
  }

  const CONFIG_FILE = jsonPath('config');
  let configRaw = null;
  let configInvalid = false;
  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8');
    configRaw = JSON.parse(text);
    if (!configRaw || typeof configRaw !== 'object' || Array.isArray(configRaw)) {
      throw new Error('配置根节点不是对象');
    }
  } catch (e) {
    configInvalid = true;
    configRaw = null;
  }
  const config = deepMerge(defaultConfig(), configRaw || {});

  /*
   * A Bridge can be deliberately exposed to a home LAN for phone shortcuts.
   * Treat both config.lan and an explicit non-loopback IB_BRIDGE_HOST as a LAN
   * exposure.  This is kept separate from `lan` so an environment override
   * cannot accidentally turn off the protection configured in config.json.
   */
  function isLoopbackHost(host) {
    const value = String(host || '').trim().toLowerCase();
    return value === 'localhost' || value === '127.0.0.1' || value === '::1' ||
      value === '[::1]' || value === '::ffff:127.0.0.1';
  }

  function createAccessToken() {
    /* URL-safe, high-entropy token: safe to paste into the existing UI field. */
    return crypto.randomBytes(32).toString('base64url');
  }

  function lanAddresses() {
    const out = [];
    try {
      const ifs = os.networkInterfaces();
      Object.keys(ifs).forEach(k => {
        (ifs[k] || []).forEach(a => {
          if (a.family === 'IPv4' && !a.internal) out.push(a.address);
        });
      });
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /* 只允许本机 / file:// 页面跨域读取，避免 lan 模式下任意网站读写本服务 */
  function corsOrigin(req) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return null;
    if (origin === 'null') return origin;
    try {
      const u = new URL(origin);
      if (u.protocol === 'file:') return origin;
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const host = String(u.hostname).toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return origin;
      }
    } catch (e) { /* 忽略非法 Origin */ }
    return null;
  }

  function persistConfig() {
    writeJson(CONFIG_FILE, config);
  }

  function configNeedsUpgrade() {
    const d = defaultConfig();
    if (!configRaw || typeof configRaw !== 'object') return false;
    if (Object.keys(d).some(k => !(k in configRaw))) return true;
    let nestedMissing = false;
    ['music', 'tts', 'ttsMimo', 'voiceAsr', 'bark', 'ntfy', 'proactive'].forEach(k => {
      const dv = d[k], rv = configRaw[k];
      if (dv && typeof dv === 'object' && rv && typeof rv === 'object') {
        if (Object.keys(dv).some(n => !(n in rv))) nestedMissing = true;
      }
    });
    return nestedMissing;
  }

  function ensureConfigFile() {
    if (!fs.existsSync(CONFIG_FILE)) {
      persistConfig();
      console.log('[IB Bridge] 已生成配置文件: ' + CONFIG_FILE);
      console.log('[IB Bridge] 默认不开启鉴权（仅监听 127.0.0.1）。如需鉴权，请编辑配置里的 token。');
      return;
    }
    if (configInvalid) {
      try {
        const broken = CONFIG_FILE + '.broken-' + Date.now().toString(36);
        fs.copyFileSync(CONFIG_FILE, broken);
        console.warn('[IB Bridge] 配置文件损坏，已备份到 ' + broken + '，并重建默认配置。');
      } catch (e) {
        console.warn('[IB Bridge] 配置文件损坏且备份失败：' + String(e && e.message || e));
      }
      persistConfig();
      return;
    }
    if (configNeedsUpgrade()) {
      persistConfig();
      console.log('[IB Bridge] 配置文件已自动补齐新字段（lan / music / tts / ntfy 等）。');
    }
  }
  ensureConfigFile();

  /*
   * A blank token is convenient and intentional for a loopback-only service.
   * It is never safe for a LAN listener: generate one during migration so a
   * config edit cannot leave every REST endpoint writable by other devices.
   * IB_BRIDGE_HOST has the same rule, even when config.lan was left false.
   */
  const configuredHost = process.env.IB_BRIDGE_HOST || (config.lan ? '0.0.0.0' : '127.0.0.1');
  const lanExposed = !!config.lan || !isLoopbackHost(configuredHost);
  if (lanExposed && !String(config.token || '').trim()) {
    config.token = createAccessToken();
    persistConfig();
    console.warn('[IB Bridge] LAN listener requires an access token. A new token was generated in config.json.');
  }
  const bindHost = configuredHost;

  function isLoopbackRequest(req) {
    let address = '';
    try { address = String(req.socket && req.socket.remoteAddress || '').toLowerCase(); } catch (e) { /* ignore */ }
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  function suppliedToken(req, query) {
    const auth = String(req.headers && req.headers.authorization || '').trim();
    const bearer = auth.match(/^bearer\s+(.+)$/i);
    if (bearer) return bearer[1].trim();
    const headerToken = String(req.headers && req.headers['x-ib-token'] || '').trim();
    if (headerToken) return headerToken;
    /* Query support is for iOS Shortcuts / MacroDroid that cannot add headers.
       Browser UI never uses it because URLs can be stored in history/logs. */
    return String(query && (query.token || query.ib_token) || '').trim();
  }

  function needsHttpToken(req) {
    /* Retain the zero-configuration loopback experience. Once a service is
       LAN-exposed, require a token from every client, including localhost. */
    return lanExposed || (!!String(config.token || '').trim() && !isLoopbackRequest(req));
  }

  function httpAuthorized(req, query) {
    if (!needsHttpToken(req)) return true;
    return constantTimeTokenMatch(suppliedToken(req, query), config.token);
  }

  return {
    config,
    configInvalid,
    configFile: CONFIG_FILE,
    jsonPath,
    defaultConfig,
    persistConfig,
    isLoopbackHost,
    createAccessToken,
    lanAddresses,
    corsOrigin,
    lanExposed,
    bindHost,
    isLoopbackRequest,
    suppliedToken,
    needsHttpToken,
    httpAuthorized
  };
}

module.exports = createConfig;
