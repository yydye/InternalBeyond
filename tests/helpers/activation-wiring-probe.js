'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   P21-R4-A.1 / R4-A.2 · Activation Wiring Probe（Node，零依赖，零浏览器）
   ──────────────────────────────────────────────────────────────────────────
   为什么存在：
   R2-A 的 contract test 曾经用**字面量匹配**断言"没有任何生产文件调用
   memoryAuthority.recordActivation"。R2-H2 合法接线之后，真实调用走的是局部
   别名（memory.js 的 `auth.recordActivation(...)`），于是那条断言依然绿着，
   却不再守任何东西（R4-A 登记的 stale guard）。

   本 probe 用**行为**取代字面量：把 assets/js/memory.js 里真实的顶层函数
   原样抽出来，在隔离的 vm 里只注入桩全局后执行，如实报告结果。

   两组 probe：
     runProbe(root)   —— recall 强化路径（_ibMemoryAuthority / recordMemoryActivation）
     runUiProbe(root) —— 两条 UI 路径（saveInlineEdit / writeOneLineToMemory）
                          R4-A.2 的核心断言：**编辑不是激活**。

   它**不**验证：Home Node 端行为、hydrate、retry 幂等、双端 parity ——
   那些由 test_memory_activation_authority.js / test_memory_recall_cooldown_hosts.js
   覆盖。这里只冻结 browser 侧的 wiring 语义。

   零网络、零 IndexedDB、零真实 memories 行、零 provider 调用。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const ACTIVE_MODES = ['canonical', 'mirror', 'off'];

/* ── 顶层函数切片 ─────────────────────────────────────────────────────────
   本文件的顶层声明以**列 0 的 `}`** 收尾（内部块一律缩进）。切片器刻意保持
   极简：找不到边界就抛错，让守卫**显式失败**，绝不静默退化成空断言。 */
function sliceTopLevelFunction(source, signature) {
  const at = source.indexOf('\n' + signature);
  if (at < 0) return null;
  const from = at + 1;
  const end = source.indexOf('\n}\n', from);
  if (end < 0) return null;
  return source.slice(from, end + 3);
}

/* ── 注释剥离 ─────────────────────────────────────────────────────────────
   为什么需要：R4-A.2 的修复注释里**逐字引用了被删除的旧代码**
   （否则读者无法核对我们删了什么）。如果写者扫描器直接扫原文，
   注释里的引用会被误判成"仍然存在的写者"。
   因此扫描**代码**前必须先剥掉注释；字符串字面量必须保留（URL 里的 `//`
   不能当成行注释），所以这里用一个小状态机而不是正则。

   验证：调用方应断言剥离后的文本仍然包含已知存活的代码片段
   （probe 里由 `assertStripperSane` 提供）。

   为什么要处理**正则字面量**：memory.js 里有
   `resp.replace(/^["'"'\u201C\u201D]|…/g,'')` 这种"正则里带引号"的写法。
   朴素的引号状态机在这里会被正则内部的 `"` / `'` 带偏，从此一直以为
   "还在字符串里"，于是**后面所有注释都不会被剥离** —— 正是这个 bug 让
   R4-A.2 的修复注释一度被误判成"仍然存在的写者"。
   因此这里按标准启发式判断 `/` 是除号还是正则开头。 */
const REGEX_AFTER_CHAR = '(,=:[!&|?{};';
const REGEX_AFTER_WORD = ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
  'void', 'do', 'else', 'yield', 'await', 'case'];

function stripJsComments(source) {
  const s = String(source == null ? '' : source);
  let out = '';
  let i = 0;
  let state = null; /* null | "'" | '"' | '`' | '//' | '/*' */
  let prevChar = '';
  let prevWord = '';
  const enter = (ch) => {
    if (/\s/.test(ch)) return;
    prevChar = ch;
    if (/[A-Za-z_$]/.test(ch)) prevWord = prevWord + ch;
    else prevWord = '';
  };
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (state === null) {
      if (c === '/' && d === '/') { state = '//'; i += 2; continue; }
      if (c === '/' && d === '*') { state = '/*'; i += 2; out += ' '; continue; }
      const regexAllowed = prevChar === '' || REGEX_AFTER_CHAR.indexOf(prevChar) >= 0
        || REGEX_AFTER_WORD.indexOf(prevWord) >= 0;
      if (c === '/' && regexAllowed) {
        out += c; i++;
        let inClass = false;
        let closed = false;
        while (i < s.length) {
          const rc = s[i];
          if (rc === '\\') { out += rc + (s[i + 1] === undefined ? '' : s[i + 1]); i += 2; continue; }
          if (rc === '\n') break;            /* 未闭合：放弃，按普通字符继续 */
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) { out += rc; i++; closed = true; break; }
          out += rc; i++;
        }
        prevChar = '/'; prevWord = '';
        if (closed) continue;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i++; continue; }
      out += c; enter(c); i++; continue;
    }
    if (state === '//') { if (c === '\n') { state = null; out += c; enter(c); } i++; continue; }
    if (state === '/*') {
      if (c === '*' && d === '/') { state = null; i += 2; out += ' '; continue; }
      if (c === '\n') out += c;
      i++; continue;
    }
    /* 字符串内部 */
    if (c === '\\') { out += c + (d === undefined ? '' : d); i += 2; continue; }
    if (c === state) { state = null; out += c; prevChar = c; prevWord = ''; i++; continue; }
    out += c; i++; continue;
  }
  return out;
}

function assertStripperSane(source, stripped) {
  const probes = ['function recordMemoryActivation(', 'function writeOneLineToMemory(',
    'function saveInlineEdit(', 'await dbPut(\'memories\'', 'activationCount'];
  const missing = probes.filter(p => source.indexOf(p) >= 0 && stripped.indexOf(p) < 0);
  if (missing.length) throw new Error('comment stripper ate live code: ' + missing.join(' | '));
  return true;
}

/* ── R4-A.3 · resolver-throw 结构性证明 ───────────────────────────────────
   `_ibMemoryAuthority()` 是否可以**抛出**？静态判据：整个函数体被 try/catch
   包住，且唯一的 catch 分支 `return null`，函数体内没有别的 `throw`。
   满足这三条 ⇒ 任何内部异常（例如 window.IB / slot.instance / status 是
   throwing getter）都被就地转成 null，**不可能**传播给调用方。
   这个 helper 的价值在于：未来若有人把它改成会抛的形状，本断言立刻变红。 */
function resolverIsStructurallyThrowSafe(source) {
  const fn = sliceTopLevelFunction(source, 'function _ibMemoryAuthority()');
  if (!fn) return { ok: false, reason: 'resolver-not-found' };
  const hasTry = /try\s*\{/.test(fn);
  const catchReturnsNull = /catch\s*\([^)]*\)\s*\{\s*return null;?\s*\}/.test(fn);
  const noOwnThrow = !/\bthrow\b/.test(fn);
  return {
    ok: hasTry && catchReturnsNull && noOwnThrow,
    hasTry: hasTry,
    catchReturnsNull: catchReturnsNull,
    noOwnThrow: noOwnThrow
  };
}

function loadMemorySource(root) {
  const base = root || ROOT;
  return fs.readFileSync(path.join(base, 'assets', 'js', 'memory.js'), 'utf8');
}

function loadActivationSource(root) {
  const source = loadMemorySource(root);
  const resolver = sliceTopLevelFunction(source, 'function _ibMemoryAuthority()');
  const record = sliceTopLevelFunction(source, 'async function recordMemoryActivation(selectedIds,at)');
  if (!resolver || !record) {
    throw new Error('activation wiring probe: memory.js top-level function slice is incomplete '
      + '(resolver=' + !!resolver + ', record=' + !!record + ')');
  }
  return { resolver: resolver, record: record, source: source };
}

function loadUiSource(root) {
  const source = loadMemorySource(root);
  const save = sliceTopLevelFunction(source, 'async function saveInlineEdit(id)');
  const oneLine = sliceTopLevelFunction(source, 'async function writeOneLineToMemory(memId)');
  if (!save || !oneLine) {
    throw new Error('activation wiring probe: memory.js UI function slice is incomplete '
      + '(saveInlineEdit=' + !!save + ', writeOneLineToMemory=' + !!oneLine + ')');
  }
  return { save: save, oneLine: oneLine, source: source };
}

/* ── 隔离 harness：recall 强化路径 ──────────────────────────────────────── */
function makeHarness(fns, options) {
  const opts = options || {};
  const calls = { authorityCalls: 0, authorityIds: null, authorityOptions: null,
    statusCalls: 0, mirrorUpdateCalls: 0, mirrorWriteCalls: 0 };
  const rows = {};
  (opts.ids || []).forEach(function (id) {
    rows[id] = { id: id, activationCount: 0, lastActivated: 0 };
  });

  const authority = opts.authority ? Object.assign({}, opts.authority) : null;
  if (authority && typeof opts.authority.recordActivation === 'function') {
    authority.recordActivation = function (ids, callOptions) {
      calls.authorityCalls++;
      calls.authorityIds = Array.prototype.slice.call(ids);
      calls.authorityOptions = callOptions || null;
      return opts.authority.recordActivation(ids, callOptions);
    };
  }
  if (authority && typeof opts.authority.status === 'function') {
    authority.status = function () {
      calls.statusCalls++;
      return opts.authority.status();
    };
  }

  const windowStub = {};
  if (authority) windowStub.IB = { memoryAuthority: { instance: authority } };
  if (opts.directModule) {
    windowStub.IBMemoryAuthority = (opts.directModule === true && authority) ? authority : opts.directModule;
  }
  if (opts.withDbUpdate !== false) {
    windowStub.dbUpdate = function (store, id, mutate) {
      calls.mirrorUpdateCalls++;
      const next = mutate(rows[id] ? Object.assign({}, rows[id]) : null);
      if (!next) return Promise.resolve(false);
      rows[id] = next;
      calls.mirrorWriteCalls++;
      return Promise.resolve(true);
    };
  }

  const sandbox = {
    window: windowStub,
    dbGet: function (store, id) { return Promise.resolve(rows[id] || null); },
    dbPut: function (store, row) {
      calls.mirrorWriteCalls++;
      rows[row.id] = row;
      return Promise.resolve(true);
    },
    Number: Number, Array: Array, Object: Object, String: String,
    Date: Date, JSON: JSON, Math: Math, Promise: Promise, Error: Error
  };
  const body = (opts.resolverThrows
    ? 'function _ibMemoryAuthority(){ throw new Error("resolver-boom"); }\n'
    : fns.resolver + '\n') + fns.record
    + '\nreturn { record: recordMemoryActivation, resolve: _ibMemoryAuthority };';
  const api = vm.runInNewContext('(function(){' + body + '\n})()', sandbox, { timeout: 5000 });
  return { api: api, calls: calls, rows: rows, windowStub: windowStub };
}

function canonicalAuthority(overrides) {
  return Object.assign({
    status: function () { return { mode: 'canonical' }; },
    recordActivation: function (ids) { return Promise.resolve({ ok: true, updated: ids.length }); }
  }, overrides || {});
}

/* ── runProbe：recall 强化路径 ────────────────────────────────────────────
   每个场景都是一条**契约条款**：
     canonical  → remote-first；**任何**结局都不得回落本地乐观 +1
     mirror/off → host-local 语义原样保留（AUTHORITY §2.5）
     无 authority → 既有本地回落（不得抛错、不得静默改变结果形状） */
async function runProbe(root) {
  const fns = loadActivationSource(root);
  const scenario = {};
  async function capture(name, options) {
    const harness = makeHarness(fns, Object.assign({ ids: ['m1', 'm2'] }, options));
    const selection = (options && options.selection) ? options.selection : ['m1', 'm2'];
    let returned = null;
    let threw = null;
    try { returned = await harness.api.record(selection, 1700000000000); }
    catch (error) { threw = String((error && error.message) || error); }
    scenario[name] = {
      authorityCalls: harness.calls.authorityCalls,
      authorityIds: harness.calls.authorityIds,
      authorityOptions: harness.calls.authorityOptions,
      statusCalls: harness.calls.statusCalls,
      mirrorUpdateCalls: harness.calls.mirrorUpdateCalls,
      mirrorWriteCalls: harness.calls.mirrorWriteCalls,
      returned: returned,
      threw: threw,
      rowActivationCounts: Object.keys(harness.rows).sort().map(function (id) { return harness.rows[id].activationCount; })
    };
  }

  await capture('canonicalSuccess', { authority: canonicalAuthority() });
  await capture('canonicalDefiniteFailure', {
    authority: canonicalAuthority({ recordActivation: function () { return Promise.resolve({ ok: false, error: 'activation-failed' }); } })
  });
  await capture('canonicalTransportThrow', {
    authority: canonicalAuthority({ recordActivation: function () { return Promise.reject(new Error('ECONNRESET')); } })
  });
  /* R4-A.2 新增：同步 throw（不是 rejected promise）。 */
  await capture('canonicalSyncThrow', {
    authority: canonicalAuthority({ recordActivation: function () { throw new Error('sync-boom'); } })
  });
  /* R4-A.2 新增：authority 存在但 status() 自己炸 —— 读不出 mode 就不准猜。 */
  await capture('canonicalStatusThrows', {
    authority: canonicalAuthority({ status: function () { throw new Error('status-boom'); } })
  });
  /* R4-A.2 新增：resolve 出非法形状（既不是 ok 也不是错误对象）。 */
  await capture('canonicalInvalidResultShape', {
    authority: canonicalAuthority({ recordActivation: function () { return Promise.resolve('not-an-object'); } })
  });
  await capture('canonicalMissingOkFlag', {
    authority: canonicalAuthority({ recordActivation: function () { return Promise.resolve(null); } })
  });
  /* R4-A.3 新增：已经解析到 authority，但它没有 status() ⇒ 归属不可判定。
     这**不是**"没有 authority"，因此不得本地回落。 */
  await capture('authorityWithoutStatus', {
    authority: { recordActivation: function (ids) { return Promise.resolve({ ok: true, updated: ids.length }); } }
  });
  /* R4-A.3 新增：resolver **自身**抛出（与 status() 抛出、recordActivation reject 是三种不同的失败）。 */
  await capture('authorityResolverThrows', { authority: canonicalAuthority(), resolverThrows: true });
  /* ── R4-A.4 · mode validation：合法 mode 只有 canonical / mirror / off ────
     其它一律 **fail closed**；**MUST NOT** 把"未知 mode"当成 mirror/off。 */
  await capture('statusModeUnknown', {
    authority: canonicalAuthority({ status: function () { return { mode: 'weird' }; } })
  });
  await capture('statusModeNull', {
    authority: canonicalAuthority({ status: function () { return { mode: null }; } })
  });
  await capture('statusModeUndefined', {
    authority: canonicalAuthority({ status: function () { return { mode: undefined }; } })
  });
  await capture('statusReturnsEmptyObject', {
    authority: canonicalAuthority({ status: function () { return {}; } })
  });
  await capture('statusReturnsNonObject', {
    authority: canonicalAuthority({ status: function () { return 'canonical'; } })
  });
  await capture('mirrorMode', {
    authority: canonicalAuthority({ status: function () { return { mode: 'mirror' }; } })
  });
  await capture('offMode', {
    authority: canonicalAuthority({ status: function () { return { mode: 'off' }; } })
  });
  await capture('noAuthority', {});
  await capture('moduleFallbackInstance', { directModule: true, authority: canonicalAuthority() });
  await capture('authorityWithoutRecordActivation', {
    authority: { status: function () { return { mode: 'canonical' }; } }
  });
  await capture('mirrorWithoutDbUpdate', {
    authority: canonicalAuthority({ status: function () { return { mode: 'mirror' }; } }),
    withDbUpdate: false
  });
  await capture('emptySelection', { authority: canonicalAuthority(), selection: [] });

  return {
    probe: 'P21-R4-A.4',
    modes: ACTIVE_MODES.slice(),
    ids: ['m1', 'm2'],
    scenarios: scenario
  };
}

/* ── runUiProbe：两条 UI 路径 ─────────────────────────────────────────────
   R4-A.2 的核心冻结：**编辑内容不是激活**。
   因此 canonical / mirror / off 三种模式下，两条 UI 路径都必须：
     · 内容照常持久化（oneLine / 表单字段）
     · activationCount 与 lastActivated **一字不变**
     · 完全不触碰 activation authority（既不调用，也不自己改镜像遥测） */
function makeUiHarness(fns, options) {
  const opts = options || {};
  const calls = { authorityCalls: 0, dbPutCalls: 0, rendered: 0, reconciled: 0 };
  const rows = {};
  const fields = {};
  Object.keys(opts.fields || {}).forEach(function (key) { fields[key] = opts.fields[key]; });

  const authority = opts.authority ? Object.assign({}, opts.authority) : null;
  if (authority && typeof opts.authority.recordActivation === 'function') {
    const original = opts.authority.recordActivation;
    authority.recordActivation = function () { calls.authorityCalls++; return original.apply(this, arguments); };
  }

  const windowStub = {};
  if (authority) windowStub.IB = { memoryAuthority: { instance: authority } };

  const documentStub = {
    getElementById: function (id) {
      return Object.prototype.hasOwnProperty.call(fields, id) ? { value: fields[id] } : null;
    },
    querySelectorAll: function () { return []; }
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    dbGet: function (store, id) { return Promise.resolve(rows[id] ? JSON.parse(JSON.stringify(rows[id])) : null); },
    dbPut: function (store, row) {
      if (opts.dbPutThrows) return Promise.reject(new Error(String(opts.dbPutThrows)));
      calls.dbPutCalls++; rows[row.id] = row; return Promise.resolve(true);
    },
    toast: function () {},
    renderMemories: function () { calls.rendered++; },
    updateMemDashboard: function () {},
    _reconcileReferences: function () { calls.reconciled++; return Promise.resolve(); },
    apiConfigs: opts.apiConfigs || [],
    _ibApiHasCredential: function () { return opts.hasCredential !== false; },
    getMemoryContext: function () { return Promise.resolve(''); },
    callApi: function () { return Promise.resolve(opts.modelReply == null ? '一句新的话' : opts.modelReply); },
    console: console,
    Number: Number, Array: Array, Object: Object, String: String,
    Date: Date, JSON: JSON, Math: Math, Promise: Promise, Error: Error
  };
  const body = fns.save + '\n' + fns.oneLine
    + '\nreturn { saveInlineEdit: saveInlineEdit, writeOneLineToMemory: writeOneLineToMemory };';
  const api = vm.runInNewContext('(function(){' + body + '\n})()', sandbox, { timeout: 5000 });
  return { api: api, calls: calls, rows: rows, fields: fields };
}

function seedRow(id, overrides) {
  return Object.assign({
    id: id, title: '标题', summary: '', content: '原始内容', oneLine: '',
    domain: '日常', rawSource: 'manual', tags: [],
    valence: 0.5, arousal: 0.3, importance: 5, resolved: false, pinned: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    createdBy: 'user', createdByName: '',
    activationCount: 7, lastActivated: 1600000000000,
    created: 1500000000000
  }, overrides || {});
}

async function runUiProbe(root) {
  const fns = loadUiSource(root);
  const out = {};
  const MODE_AUTHORITY = {
    canonical: function () { return canonicalAuthority(); },
    mirror: function () { return canonicalAuthority({ status: function () { return { mode: 'mirror' }; } }); },
    off: function () { return canonicalAuthority({ status: function () { return { mode: 'off' }; } }); }
  };

  for (const mode of ACTIVE_MODES) {
    /* ① saveInlineEdit（编辑表单 → 内容） */
    const saveHarness = makeUiHarness(fns, {
      authority: MODE_AUTHORITY[mode](),
      fields: {
        'mce-title-m1': '改后的标题', 'mce-summary-m1': '改后的概括', 'mce-oneline-m1': '改后的引言',
        'mce-content-m1': '改后的正文', 'mce-domain-m1': '思考', 'mce-source-m1': 'chat',
        'mce-tags-m1': 'a, b', 'mce-v-m1': '0.9', 'mce-a-m1': '0.8', 'mce-imp-m1': '9',
        'mce-resolved-m1': 'true', 'mce-pinned-m1': 'false', 'mce-vis-m1': 'public'
      }
    });
    saveHarness.rows.m1 = seedRow('m1');
    await saveHarness.api.saveInlineEdit('m1');
    const savedRow = saveHarness.rows.m1;
    out['saveInlineEdit@' + mode] = {
      authorityCalls: saveHarness.calls.authorityCalls,
      dbPutCalls: saveHarness.calls.dbPutCalls,
      reconciled: saveHarness.calls.reconciled,
      rendered: saveHarness.calls.rendered,
      content: savedRow ? savedRow.content : null,
      title: savedRow ? savedRow.title : null,
      oneLine: savedRow ? savedRow.oneLine : null,
      activationCount: savedRow ? savedRow.activationCount : null,
      lastActivated: savedRow ? savedRow.lastActivated : null
    };

    /* ② writeOneLineToMemory（AI 写一句话 → oneLine 内容） */
    const oneLineHarness = makeUiHarness(fns, {
      authority: MODE_AUTHORITY[mode](),
      apiConfigs: [{ id: 'role_1', nickname: '角色', model: 'm', systemPrompt: '', relationship: '' }],
      modelReply: '雨声让人安心'
    });
    oneLineHarness.rows.m1 = seedRow('m1', { createdBy: 'role_1', createdByName: '角色' });
    await oneLineHarness.api.writeOneLineToMemory('m1');
    const oneLineRow = oneLineHarness.rows.m1;
    out['writeOneLineToMemory@' + mode] = {
      authorityCalls: oneLineHarness.calls.authorityCalls,
      dbPutCalls: oneLineHarness.calls.dbPutCalls,
      rendered: oneLineHarness.calls.rendered,
      oneLine: oneLineRow ? oneLineRow.oneLine : null,
      content: oneLineRow ? oneLineRow.content : null,
      activationCount: oneLineRow ? oneLineRow.activationCount : null,
      lastActivated: oneLineRow ? oneLineRow.lastActivated : null
    };
  }

  /* ③ content write failure：dbPut 抛错时，调用方行为**如实记录**（不改变内容写入路径），
        但遥测必须仍然不变。 */
  const failing = makeUiHarness(fns, {
    authority: MODE_AUTHORITY.canonical(),
    fields: { 'mce-title-m1': 'T', 'mce-content-m1': 'C' },
    dbPutThrows: 'mirror-write-failed'
  });
  failing.rows.m1 = seedRow('m1');
  let failureOutcome;
  try {
    await failing.api.saveInlineEdit('m1');
    failureOutcome = 'resolved';
  } catch (error) {
    failureOutcome = String((error && error.message) || error);
  }
  out.saveInlineEditContentWriteFailure = {
    outcome: failureOutcome,
    authorityCalls: failing.calls.authorityCalls,
    activationCount: failing.rows.m1 ? failing.rows.m1.activationCount : null,
    lastActivated: failing.rows.m1 ? failing.rows.m1.lastActivated : null
  };

  /* ④ content-only edit：只改标题/正文，其它一切（重要性/唤醒度/状态/可见性…）
        保持与种子完全一致。这是 §13 MemoryValue recency 保护的探针来源：
        测试会用**生产 scorer** 比较 before / after。 */
  const contentOnly = makeUiHarness(fns, {
    authority: MODE_AUTHORITY.canonical(),
    fields: {
      'mce-title-m1': '新标题', 'mce-summary-m1': '', 'mce-oneline-m1': '', 'mce-content-m1': '新正文',
      'mce-domain-m1': '日常', 'mce-source-m1': 'manual', 'mce-tags-m1': '',
      'mce-v-m1': '0.5', 'mce-a-m1': '0.3', 'mce-imp-m1': '5', 'mce-resolved-m1': 'false',
      'mce-pinned-m1': 'false', 'mce-vis-m1': 'public'
    }
  });
  contentOnly.rows.m1 = seedRow('m1');
  const contentOnlyBefore = JSON.parse(JSON.stringify(contentOnly.rows.m1));
  await contentOnly.api.saveInlineEdit('m1');
  out.saveInlineEditContentOnly = {
    authorityCalls: contentOnly.calls.authorityCalls,
    before: contentOnlyBefore,
    after: contentOnly.rows.m1
  };

  return { probe: 'P21-R4-A.4', modes: ACTIVE_MODES.slice(), scenarios: out };
}

module.exports = {
  ROOT, ACTIVE_MODES, stripJsComments, assertStripperSane, sliceTopLevelFunction,
  resolverIsStructurallyThrowSafe,
  loadMemorySource, loadActivationSource, loadUiSource,
  makeHarness, makeUiHarness, seedRow, canonicalAuthority,
  runProbe, runUiProbe
};

if (require.main === module) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
  Promise.all([runProbe(root), runUiProbe(root)]).then(function (results) {
    process.stdout.write(JSON.stringify({ recall: results[0], ui: results[1] }, null, 2) + '\n');
  }, function (error) {
    process.stderr.write('activation wiring probe failed: ' + String((error && error.message) || error) + '\n');
    process.exit(1);
  });
}
