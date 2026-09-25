'use strict';
/* Internal Beyond · P27-C · Activity runtime partition helper（**测试侧**工具）

   目的（HASH_COUPLING_DEBT 的结构性修复）：
   P27-2 / P27-3 / P27-4 反复修改 `activity-runtime.js`，导致**同一批** 7 个守卫
   每阶段都要重签**整文件哈希** —— 而被守护的不变量（canonical writer 唯一 / 指针语义 /
   既有生命周期函数 / 既有事件机制 / 导出面）从未改变。这就是 B 类哈希耦合。

   本工具把 `activity-runtime.js` 按**语义分区**切开（函数体级），只冻结**既有**分区；
   P27 新增的领域适配器（`getObservation` / `getSession` / `_emitActivityCreated`）
   **不在**冻结集合内 ⇒ 未来再新增一个独立 getter 不需要重签任何既有守卫。

   机制（§19 首选）：**源码级函数抽取 + 逐函数哈希**（不用行号、不依赖整文件）。
   注意：注释会被剥离后再哈希 ⇒ 注释编辑不会触发重签，代码变化一定会。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = 'assets/js/activity/activity-runtime.js';

const stripComments = src => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex').toUpperCase();

/* 语义分区 → 该分区包含的函数名（**既有**函数；P27 适配器刻意排除） */
const PARTITIONS = Object.freeze({
  canonical_writer: ['createActivity', 'getActivity', 'findActivity', 'listActivities',
    'saveActivity', 'deleteActivity', 'setProgress'],
  pointer: ['_ptrAll', '_ptrWrite', '_ptrGet', '_ptrSet', '_ptrClear', '_usableFor',
    'setCurrent', 'clearCurrent', 'resolveActivity'],
  context_read: ['_chapterAt', 'buildActivityContext', 'getActivityContext'],
  chat_bridge: ['send', 'openChat'],
  memory_nudge: ['writeMemory', 'nudge'],
  event_mechanism: ['_on', '_off', '_emit', 'mark', 'fav'],
  helpers: ['_now', '_esc', '_fmt', '_toast', '_ensureThread']
});

/* P27 新增的领域适配器 —— **不**属于任何冻结分区 */
const P27_ADAPTERS = Object.freeze(['getObservation', 'getSession', '_emitActivityCreated']);

/* P27-C 冻结的既有分区摘要（由本工具 --print 生成；只覆盖既有函数） */
const LEGACY_DIGESTS = Object.freeze({
  canonical_writer: '8E49A04F831D9758F9B4D2F56C407B6C18F69C7846D80D8377AB20418FEC8587',
  pointer: '7BA09F0BD1D4F16E6AA60529A2954507D5AB3C9C9E2D6267A11A10631E7CB313',
  context_read: '40FA96C2D3980869E66F9DB572048486F1B28FB71DDF1B2C39D47EAE675CBC6B',
  chat_bridge: '4CD70D5DE49B4D3C5F4F72DB250D0A5B24CBEA2C12A0B9AF2CD1E2A21782E8B5',
  memory_nudge: 'FC8012E4374584EC5107427F2BEFBEBDC9B6694B6237FDB75E59154AAD1AB92A',
  event_mechanism: '8AD77E07C95EFDABD487AAE02F6B3BA6D9E477C2B55E845287866D7572A77C91',
  helpers: '3CF18371E24260518F2D3A0342EBB50A540A525CFBE560DF393EC21B45FB3185'
});

/* 抽取：函数名 → 函数体源码（注释已剥离；用花括号配对，不用行号） */
function extractFunctions(src) {
  const code = stripComments(src);
  const out = {};
  const re = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[1];
    const braceIdx = code.indexOf('{', m.index);
    if (braceIdx < 0) continue;
    let depth = 0, end = -1;
    for (let j = braceIdx; j < code.length; j++) {
      const c = code[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) continue;
    const body = code.slice(m.index, end);
    out[name] = out[name] ? (out[name] + '\n' + body) : body;
  }
  return out;
}

function readRuntime() { return fs.readFileSync(path.join(ROOT, RUNTIME), 'utf8'); }

/* 导出的 api 面（`var api={...};` 的键） */
function exportKeys(src) {
  const code = stripComments(src || readRuntime());
  const m = code.match(/var api=\{([\s\S]*?)\};/);
  if (!m) return [];
  const keys = [];
  const kre = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;
  let k;
  while ((k = kre.exec(m[1]))) keys.push(k[1]);
  return keys.sort();
}

function partitionDigest(name, src) {
  const fns = PARTITIONS[name];
  if (!fns) return '';
  const bodies = extractFunctions(src || readRuntime());
  const parts = fns.map(f => (bodies[f] === undefined ? ('MISSING:' + f) : bodies[f]));
  return sha256(parts.join('\n/*--*/\n'));
}

function allPartitionDigests(src) {
  const out = {};
  for (const name of Object.keys(PARTITIONS)) out[name] = partitionDigest(name, src);
  return out;
}

function legacyPartitionMismatches(src) {
  const actual = allPartitionDigests(src);
  return Object.keys(LEGACY_DIGESTS).filter(k => LEGACY_DIGESTS[k] && actual[k] !== LEGACY_DIGESTS[k]);
}

function legacyPartitionsMatch(src) {
  const recorded = Object.keys(LEGACY_DIGESTS).filter(k => LEGACY_DIGESTS[k]);
  return recorded.length === Object.keys(PARTITIONS).length
    && legacyPartitionMismatches(src).length === 0;
}

module.exports = {
  RUNTIME: RUNTIME,
  PARTITIONS: PARTITIONS,
  P27_ADAPTERS: P27_ADAPTERS,
  LEGACY_DIGESTS: LEGACY_DIGESTS,
  stripComments: stripComments,
  sha256: sha256,
  extractFunctions: extractFunctions,
  readRuntime: readRuntime,
  exportKeys: exportKeys,
  partitionDigest: partitionDigest,
  allPartitionDigests: allPartitionDigests,
  legacyPartitionsMatch: legacyPartitionsMatch,
  legacyPartitionMismatches: legacyPartitionMismatches
};

/* `node tests/activity-partitions.js --print` → 打印当前分区摘要（用于冻结） */
if (require.main === module && process.argv.indexOf('--print') >= 0) {
  const d = allPartitionDigests();
  console.log(JSON.stringify(d, null, 2));
  console.log('exports=' + JSON.stringify(exportKeys()));
}
