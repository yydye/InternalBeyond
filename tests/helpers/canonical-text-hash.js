'use strict';
/* ====================================================================
   Internal Beyond · Test-only canonical text hash
   --------------------------------------------------------------------
   为什么存在（R2-F1b-HASH-BYTES-1）：
     历史 verification hash 直接对 `fs.readFileSync(p)` 的 **raw working-tree
     bytes** 取 sha256。但同一份逻辑内容在不同 checkout 上会被
     `core.autocrlf` / `.gitattributes` 物化成**不同字节**（CRLF vs LF），
     于是"内容没变"也会判定为 hash mismatch —— 那是 **EOL false positive**，
     不是真实内容漂移。

     本 helper 把 verification 收敛到**字节级 canonical**：只把 CRLF 变成 LF，
     其余**逐字节保留**。

   ⚠ 语义边界（严格）：
     · 唯一归一化的字节序列 = 0x0D 0x0A → 0x0A
     · lone 0x0D（不跟 0x0A）**保留原样**，不得转换、不得删除
     · BOM（EF BB BF）保留
     · trailing spaces / tabs 保留
     · final newline 的有无保留
     · **不做** UTF-8 decode / re-encode（因此非规范 UTF-8 字节序列逐字保留）
     · 不 trim、不 Unicode normalize、不格式化

   ⚠ 只允许 test 使用。**不得**放进 production。
   ==================================================================== */

const crypto = require('node:crypto');

const CR = 0x0D;
const LF = 0x0A;

/* canonicalTextBytes(buffer) → Buffer
   逐字节扫描：遇到 CR 且下一个是 LF ⇒ 丢弃该 CR；其余一律原样写出。
   刻意**不用** buf.toString('utf8').replace(...) 再编码：
   那会破坏非规范 UTF-8 字节序列（H9 就是为这条设的守卫）。 */
function canonicalTextBytes(buffer) {
  const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const out = Buffer.allocUnsafe(src.length);
  let w = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === CR && i + 1 < src.length && src[i + 1] === LF) continue;
    out[w++] = src[i];
  }
  return out.subarray(0, w);
}

/* canonicalTextSha256(buffer) → 大写 hex（与既有 fixture 格式一致） */
function canonicalTextSha256(buffer) {
  return crypto.createHash('sha256').update(canonicalTextBytes(buffer)).digest('hex').toUpperCase();
}

/* 仅供对照/诊断：raw 哈希（**不**用于 verification 判定） */
function rawSha256(buffer) {
  const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return crypto.createHash('sha256').update(src).digest('hex').toUpperCase();
}

module.exports = { canonicalTextBytes, canonicalTextSha256, rawSha256 };
