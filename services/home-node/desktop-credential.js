/* ====================================================================
   IB Home Node · Desktop credential authority（唯一一份）
   --------------------------------------------------------------------
   P22-23。这个模块回答的**只有一个**问题：

     这台机器的桌面凭据是什么，它是从哪来的，以及它是不是可靠的？

   在它存在之前，那个问题在仓库里有**两个**互不相干的答案：

     · 服务端：`process.env.IB_HOME_NODE_TOKEN`（services/home-node-service.js:103）
       —— 没有配置就是空串，而空串会把 Economy 的配置面 / 决定面整体关掉
       （economy-configuration.js:266 `credentialConfigured`）；
     · 浏览器：`localStorage['ib_home_node_token']`
       （assets/js/home-node-client.js:37）—— 而**没有任何代码写过它**。

   ⇒ 正常安装、正常启动的用户，两边都是空的：Home Node 健康、读面可达、
     配置面 503 「请先设置环境变量」。这不是显示问题，是**凭据从没被创造过**。

   ── 为什么 authority 放在这里，而不是 runner / 浏览器 ────────────────
   校验者才应该是持有者。Home Node 是唯一判定这条凭据的地方，所以它也是唯一
   生成与保存它的地方。放在 runner 会造出第二份（runner 生成、服务端读 env），
   放在浏览器则等于让客户端决定服务端接受什么。

   ── 三种来源，优先级固定，且**没有第四种** ─────────────────────────
     env        显式设置 IB_HOME_NODE_TOKEN。最高优先级，覆盖其余一切，
                并且**关闭**自动 provisioning —— 它是 developer / headless /
                测试的既有旋钮，本阶段一个字都没改它的语义。
     file       IB_HOME_NODE_TOKEN_FILE 指向的文件（人类显式提供的权威文件）。
     generated  本模块生成并持久化在数据目录里的 `desktop-credential.json`。
                首次启动时创建一次；此后永远读同一份。

   ── 失败方向（§6 第 7 条：缺失/损坏时 fail closed）─────────────────
   生成或持久化失败 ⇒ `ok:false` + 一个具名 reason，**绝不**退回空串。
   调用方（home-node-service.js 的 require.main 路径）据此拒绝启动：一个
   无法建立凭据的节点不应该以"看起来健康、但什么都写不了"的姿态对外服务。
   这比"悄悄用空 token 继续跑"安全，也比它诚实。

   ── 这个模块**不做**什么 ────────────────────────────────────────────
     · 不签发第二类凭据（没有 session token、没有设备 token、没有 cookie）；
     · 不把凭据交给任何网络面 —— 交付由 services/home-node/http.js 的
       bootstrap 面单独负责，且那条面有它自己的准入规则；
     · 不打印、不返回日志字段里的凭据本体。describe() 只有
       {configured, source, length, fingerprint}，fingerprint 是 sha256 前 12 位。
   ==================================================================== */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* 生成强度：32 字节 CSPRNG → 43 字符 base64url。
   没有默认值、没有兜底常量、没有"如果随机失败就用时间戳"这类退化路径 ——
   那条路径就是一个可预测的凭据。 */
const SECRET_BYTES = 32;

const SOURCE = Object.freeze({
  ENV: 'env',
  FILE: 'file',
  GENERATED: 'generated'
});

const REASON = Object.freeze({
  /* token 文件存在但读不动 / 内容不是可用的凭据。**不**重新生成：
     一个坏掉的凭据文件是"有人在动它"的证据，覆盖它等于静默销毁证据。 */
  FILE_UNREADABLE: 'desktop-credential-file-unreadable',
  FILE_MALFORMED: 'desktop-credential-file-malformed',
  /* 生成或落盘失败（权限 / 磁盘 / 目录不可写）。 */
  WRITE_FAILED: 'desktop-credential-write-failed',
  /* 显式关闭了自动 provisioning，且没有别的来源 ⇒ 空凭据（合法状态）。 */
  AUTOPROVISION_OFF: 'desktop-credential-autoprovision-disabled'
});

const FILE_NAME = 'desktop-credential.json';
const FILE_SCHEMA = 1;

/* ── 自动 provisioning 的开关 ────────────────────────────────────────
   默认**开**。这是我们希望普通用户走的那条路：装好、启动、Economy 可用。

   为什么需要一个显式开关而不是"没有 env 就自动生成"：仓库里有大量真实
   spawn 生产入口的测试，它们刻意构造"未配置凭据"这个部署形态（例如
   tests/test_home_node_production_memory_assembly.js:87）。那些测试检验的
   是一条仍然合法的部署路径（§5：env 作为 developer / headless override），
   因此它们应当**显式**说"我要那个形态"，而不是依赖一个会随产品演进的默认值。
   取值：off / 0 / false / no ⇒ 关闭；其余（含缺省）⇒ 开启。 */
function autoProvisionEnabled(env) {
  const raw = String((env || {})[AUTOPROVISION_ENV] == null ? '' : (env || {})[AUTOPROVISION_ENV]).trim().toLowerCase();
  if (raw === '') return true;
  return !(raw === 'off' || raw === '0' || raw === 'false' || raw === 'no');
}

const TOKEN_ENV = 'IB_HOME_NODE_TOKEN';
const TOKEN_FILE_ENV = 'IB_HOME_NODE_TOKEN_FILE';
const AUTOPROVISION_ENV = 'IB_HOME_NODE_TOKEN_AUTOPROVISION';

/* 安全短指纹：只够"两次读到的是不是同一份"，不足以恢复凭据。 */
function fingerprintOf(token) {
  const value = String(token == null ? '' : token);
  if (!value) return null;
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/* 凭据形状：长度有界、无控制字符、无首尾空白（首尾空白会让"看起来一样"的
   两份凭据在恒定时间比较里不相等 —— 那类 bug 极难诊断）。
   这不是强度校验（强度由生成端保证）：它只拒绝**明显不是**凭据的东西，
   例如空文件、一个 JSON 对象被误当字符串、或者半行被截断的写入。 */
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 512;
function isUsableToken(value) {
  const token = String(value == null ? '' : value);
  if (token !== token.trim()) return false;
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return false;
  /* eslint-disable-next-line no-control-regex -- 控制字符正是要拒绝的东西 */
  if (/[\u0000-\u001f\u007f]/.test(token)) return false;
  return true;
}

function credentialFilePath(dataDir) {
  return path.join(String(dataDir || '.'), FILE_NAME);
}

/* 原子写：先写临时文件再 rename。
   为什么不能直接 writeFileSync：一个被中断的写入会留下半份凭据，而下一次
   启动读到它时，它**看起来**像一份合法凭据（长度够、无控制字符），于是
   "损坏"变成了"服务端和浏览器用的不是同一个秘密"——一条只在一部分重启后
   出现的、无法从症状回推的故障。rename 在同一卷上是原子的，所以读到的
   要么是旧的完整凭据，要么是新的完整凭据。 */
function writeSecretFile(file, token) {
  const payload = JSON.stringify({
    schema: FILE_SCHEMA,
    createdAt: new Date().toISOString(),
    note: 'Internal Beyond desktop credential. Generated locally on first run. ' +
      'Revoke by deleting this file and restarting Internal Beyond.',
    token: token
  }, null, 2) + '\n';
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp');
  let fd = null;
  try {
    /* 'wx'：临时名已含 pid + 随机后缀，这里的排他创建只是再多一道保险。 */
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    /* 权限收紧到"仅本用户"。Windows 上 chmod 基本是空操作，那里靠的是
       %LOCALAPPDATA% 的每用户 ACL —— 与 Home Node 数据目录本身同一层保护。 */
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* Windows / 只读挂载上可能失败，不致命 */ }
    fs.renameSync(tmp, file);
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) { /* 已经关了 */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* 没留下临时文件就更好 */ }
    throw error;
  }
  return file;
}

/* ── 读取既有的生成文件 ──────────────────────────────────────────────
   返回 {token} 或 {reason, message}。**不**区分"文件不存在"与"文件坏了"：
   调用方先用 existsSync 问前者，走到这里的都是后者。 */
function readSecretFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { reason: REASON.FILE_UNREADABLE, message: String((error && error.message) || error) };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reason: REASON.FILE_MALFORMED, message: 'the credential file is not a JSON object' };
  }
  if (parsed.schema !== FILE_SCHEMA) {
    return { reason: REASON.FILE_MALFORMED, message: 'the credential file has an unknown schema' };
  }
  if (!isUsableToken(parsed.token)) {
    return { reason: REASON.FILE_MALFORMED, message: 'the credential file does not contain a usable token' };
  }
  return { token: String(parsed.token) };
}

/* ══════════════════════════════════════════════════════════════════
   resolveDesktopCredential —— 唯一入口
   ══════════════════════════════════════════════════════════════════
   options:
     · env      默认 process.env（测试注入用）
     · dataDir  凭据文件的目录（生产上就是 Home Node 的 DATA_DIR）
     · generate 默认 true；false 时**只读**，缺失不生成（诊断 / 只读探针用）

   返回（**永不抛错**）：{
     ok, token, source, configured, length, fingerprint,
     generatedNow, autoProvision, file, reason, message
   }
   `configured === false` 只在一种情况下出现：显式关闭了自动 provisioning
   且没有 env / file —— 也就是"有人要求这个部署不配置凭据"。
   任何**意外的**失败都是 ok:false，让调用方 fail closed。 */
function resolveDesktopCredential(options) {
  options = options || {};
  const env = options.env || process.env;
  const dataDir = options.dataDir;
  const generate = options.generate !== false;
  const autoProvision = autoProvisionEnabled(env);
  const file = credentialFilePath(dataDir);

  const base = {
    ok: true,
    token: '',
    source: null,
    configured: false,
    length: 0,
    fingerprint: null,
    generatedNow: false,
    autoProvision: autoProvision,
    file: file,
    reason: null,
    message: null
  };

  /* 1 · env —— 最高优先级，且它的存在本身就表示"部署方已经决定了凭据"。
        因此它同时关闭自动路径：不能出现"env 是 A、文件是 B"这种两套并存的
         状态，那正是本模块要消灭的东西。 */
  const envToken = String(env[TOKEN_ENV] == null ? '' : env[TOKEN_ENV]);
  if (envToken.trim() !== '') {
    return Object.assign({}, base, {
      token: envToken.trim(),
      source: SOURCE.ENV,
      configured: true,
      length: envToken.trim().length,
      fingerprint: fingerprintOf(envToken.trim())
    });
  }

  /* 2 · 显式的凭据文件（人类提供的 / 部署脚本放置的）。 */
  const explicitFile = String(env[TOKEN_FILE_ENV] == null ? '' : env[TOKEN_FILE_ENV]).trim();
  if (explicitFile) {
    if (!fs.existsSync(explicitFile)) {
      return Object.assign({}, base, {
        ok: false,
        source: SOURCE.FILE,
        file: explicitFile,
        reason: REASON.FILE_UNREADABLE,
        message: 'IB_HOME_NODE_TOKEN_FILE points at a file that does not exist'
      });
    }
    const read = readSecretFile(explicitFile);
    if (read.reason) {
      return Object.assign({}, base, { ok: false, source: SOURCE.FILE, file: explicitFile, reason: read.reason, message: read.message });
    }
    return Object.assign({}, base, {
      token: read.token,
      source: SOURCE.FILE,
      configured: true,
      length: read.token.length,
      fingerprint: fingerprintOf(read.token),
      file: explicitFile
    });
  }

  /* 3 · 生成并持久化的凭据（数据目录内）。 */
  /* ★ 开关关掉时必须在**读文件之前**就返回。这一条不是形式上的顺序问题，
     而是一个实测出来的真实缺陷：先读文件的话，`AUTOPROVISION=0` 的进程仍然
     会读到数据目录里那份**已经存在**的凭据 —— 于是所有"我要构造未配置凭据
     这个形态"的测试会静默地拿着**生产凭据**去跑（实测：测试断言 401，而它
     期望的是一条匿名可读的路径）。
     "关掉自动 provisioning"必须同时意味着"这个进程一份都不读"，否则它就
     不是一个可用来隔离的开关。 */
  if (!autoProvision) {
    return Object.assign({}, base, { reason: REASON.AUTOPROVISION_OFF, message: 'automatic credential provisioning is disabled for this process' });
  }

  if (fs.existsSync(file)) {
    const read = readSecretFile(file);
    if (read.reason) {
      /* ★ 已存在的文件坏掉时**不**重新生成：那会把"有人在改这个文件"或者
         "上一次写入被中断"静默转成"一切正常，只是换了个秘密"。fail closed，
         让调用方拒绝启动并指名这个文件。 */
      return Object.assign({}, base, { ok: false, source: SOURCE.GENERATED, reason: read.reason, message: read.message });
    }
    return Object.assign({}, base, {
      token: read.token,
      source: SOURCE.GENERATED,
      configured: true,
      length: read.token.length,
      fingerprint: fingerprintOf(read.token)
    });
  }

  /* 4 · 没有 env、没有 file、没有既有生成文件。 */
  if (!generate) {
    return Object.assign({}, base, { reason: REASON.AUTOPROVISION_OFF, message: 'this is a read-only resolution; no credential has been generated yet' });
  }

  /* cryptographically secure random —— 这是唯一的生成路径（§6 第 2 条）。 */
  const token = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  try {
    writeSecretFile(file, token);
  } catch (error) {
    return Object.assign({}, base, {
      ok: false,
      source: SOURCE.GENERATED,
      reason: REASON.WRITE_FAILED,
      message: String((error && error.message) || error)
    });
  }
  return Object.assign({}, base, {
    token: token,
    source: SOURCE.GENERATED,
    configured: true,
    length: token.length,
    fingerprint: fingerprintOf(token),
    generatedNow: true
  });
}

/* 诊断用投影。**绝不**包含 token 本体。 */
function describeCredential(resolved) {
  const r = resolved || {};
  return {
    configured: r.configured === true,
    source: r.source || null,
    length: Number(r.length) || 0,
    fingerprint: r.fingerprint || null,
    generatedNow: r.generatedNow === true,
    autoProvision: r.autoProvision === true,
    ok: r.ok === true,
    reason: r.reason || null
  };
}

module.exports = {
  SOURCE: SOURCE,
  REASON: REASON,
  FILE_NAME: FILE_NAME,
  TOKEN_ENV: TOKEN_ENV,
  TOKEN_FILE_ENV: TOKEN_FILE_ENV,
  AUTOPROVISION_ENV: AUTOPROVISION_ENV,
  SECRET_BYTES: SECRET_BYTES,
  MIN_TOKEN_LENGTH: MIN_TOKEN_LENGTH,
  MAX_TOKEN_LENGTH: MAX_TOKEN_LENGTH,
  resolveDesktopCredential: resolveDesktopCredential,
  describeCredential: describeCredential,
  credentialFilePath: credentialFilePath,
  isUsableToken: isUsableToken,
  fingerprintOf: fingerprintOf,
  autoProvisionEnabled: autoProvisionEnabled
};
