/* IB Bridge · 无状态工具函数（不依赖数据目录或服务状态）。
   从 ib-bridge-service.js 提取，保持原逻辑逐字不变。 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');

function deepMerge(base, extra) {
  const out = Object.assign({}, base);
  Object.keys(extra || {}).forEach(k => {
    const bv = base[k], ev = extra[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) &&
        ev && typeof ev === 'object' && !Array.isArray(ev)) {
      out[k] = deepMerge(bv, ev);
    } else {
      /* 类型安全：若用户写入的类型与默认值类型不匹配（如对象写成字符串），用默认值回退 */
      if (bv !== undefined && ev !== undefined && typeof ev !== typeof bv) {
        if (!(bv === null || ev === null)) {
          out[k] = bv;
          return;
        }
      }
      out[k] = ev;
    }
  });
  return out;
}

function backupBrokenFile(file, reason) {
  try {
    const broken = file + '.broken-' + Date.now().toString(36);
    fs.copyFileSync(file, broken);
    console.warn('[IB Bridge] 数据文件' + reason + '，已备份到 ' + broken);
  } catch (e) { /* 备份失败不阻断启动 */ }
}

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function todayStr(d) {
  const x = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

function constantTimeTokenMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function parseQuery(url) {
  const out = {};
  try { new URLSearchParams(url.search).forEach((v, k) => { out[k] = v; }); } catch (e) { /* 忽略 */ }
  return out;
}

module.exports = { deepMerge, backupBrokenFile, uid, todayStr, constantTimeTokenMatch, parseQuery };

