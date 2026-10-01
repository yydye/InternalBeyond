'use strict';
/* Internal Beyond · P21-R2-E1a · Glossary Catalog（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_glossary_catalog.js

   被测：assets/js/memory-recall/glossary-catalog.js

   ── 本文件冻结的核心语义（R2-E1a §2.1 / §3–§6）──────────────────────
     · target **必须**是稳定引用 {type:'memory', id}，不是自由文本 concept
     · provider 的 available 与"有没有 entry"是**两件事**
     · 规范化必须**确定性**：NFKC / trim / 稳定序 / 去重 / 丢弃畸形
     · 绝不猜 target、绝不从 title/tags 推导 alias、绝不读 DB
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REL = 'assets/js/memory-recall/glossary-catalog.js';
const G = require(path.join(ROOT, REL));

let failures = 0, passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

/* ══════════════════════════════════════════════════════════════════════
   §1 · target 必须是稳定 memory 引用
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · target = stable memory reference');

const e1 = G.normalizeEntry({ alias: '显卡', kind: 'term', target: { type: 'memory', id: 'mem_1' } });
check('1.validAliasTermToMemoryId', e1.ok && e1.entry.target.type === 'memory' && e1.entry.target.id === 'mem_1'
  && e1.entry.alias === '显卡' && e1.entry.kind === 'term', JSON.stringify(e1));

const e1b = G.normalizeEntry({ alias: 'GPU', target: { type: 'memory', id: 'mem_2' } });
check('1.defaultKindIsAlias', e1b.ok && e1b.entry.kind === 'alias', JSON.stringify(e1b));

const e1c = G.normalizeEntry({ alias: '显卡', targetMemoryId: 'mem_3' });
check('2.targetMemoryIdShorthandAccepted',
  e1c.ok && e1c.entry.target.type === 'memory' && e1c.entry.target.id === 'mem_3', JSON.stringify(e1c));

check('3.malformedTargetMissingRejected',
  G.normalizeEntry({ alias: 'x' }).reason === 'missing-target');
check('3.malformedTargetNullRejected',
  G.normalizeEntry({ alias: 'x', target: null }).reason === 'missing-target');
check('4.targetTypeNotMemoryRejected',
  G.normalizeEntry({ alias: 'x', target: { type: 'concept', id: 'c1' } }).reason === 'unsupported-target-type');
check('4.targetTypeTextRejected',
  G.normalizeEntry({ alias: 'x', target: { type: 'text', id: '一些文本' } }).reason === 'unsupported-target-type');
check('5.emptyMemoryIdRejected',
  G.normalizeEntry({ alias: 'x', target: { type: 'memory', id: '   ' } }).reason === 'empty-target-id');
check('5.missingMemoryIdRejected',
  G.normalizeEntry({ alias: 'x', target: { type: 'memory' } }).reason === 'empty-target-id');
check('5.targetIdTooLong', (() => {
  const long = 'm'.repeat(G.MAX_TARGET_ID_CHARS + 1);
  return G.normalizeEntry({ alias: 'x', target: { type: 'memory', id: long } }).reason === 'target-id-too-long';
})());
check('1.noFreeTextTargetSupported', (() => {
  /* 关键反例：把整段 concept 文本塞进 target 必须被拒 ——
     否则命中之后还要"再搜一次"，那就不再是 deterministic lookup。 */
  const r = G.normalizeEntry({ alias: '地下室', target: { type: 'memory', id: '' } });
  const r2 = G.normalizeEntry({ alias: '地下室', target: 'A dark basement concept' });
  return r.ok === false && r2.ok === false;
})(), 'a free-text concept must never become a target');
check('1.targetTypesAreAllowlisted', JSON.stringify(G.TARGET_TYPES) === JSON.stringify(['memory']));

/* ══════════════════════════════════════════════════════════════════════
   §2 · 去重与稳定序
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · dedupe / ordering');

const dup = G.normalizeCatalog([
  { alias: '显卡', kind: 'term', target: { type: 'memory', id: 'm1' } },
  { alias: '显卡', kind: 'term', target: { type: 'memory', id: 'm1' } },
  { alias: '显卡', kind: 'term', target: { type: 'memory', id: 'm1' } }
]);
check('6.duplicateEntryDeduped', dup.entries.length === 1 && dup.dropped === 2,
  JSON.stringify({ kept: dup.entries.length, dropped: dup.dropped }));

const ambig = G.normalizeCatalog([
  { alias: '显卡', kind: 'term', target: { type: 'memory', id: 'm2' } },
  { alias: '显卡', kind: 'term', target: { type: 'memory', id: 'm1' } }
]);
check('7.sameAliasDifferentMemoryIdsPreservedDeterministically',
  ambig.entries.length === 2
  && ambig.entries[0].target.id === 'm1' && ambig.entries[1].target.id === 'm2',
  'ambiguity is a real catalog state — silently picking one would be guessing: '
  + JSON.stringify(ambig.entries.map(e => e.target.id)));

const multi = G.normalizeCatalog([
  { alias: 'GPU', target: { type: 'memory', id: 'm1' } },
  { alias: '显卡', target: { type: 'memory', id: 'm1' } },
  { alias: 'graphics card', target: { type: 'memory', id: 'm1' } }
]);
check('8.sameTargetMultipleAliasesPreserved', multi.entries.length === 3, JSON.stringify(multi.entries.map(e => e.alias)));

const ordered = G.normalizeCatalog([
  { alias: 'zebra', target: { type: 'memory', id: 'm1' } },
  { alias: 'apple', target: { type: 'memory', id: 'm2' } },
  { alias: 'Mango', target: { type: 'memory', id: 'm3' } }
]);
check('11.stableOrdering',
  JSON.stringify(ordered.entries.map(e => e.alias)) === JSON.stringify(['Mango', 'apple', 'zebra']),
  JSON.stringify(ordered.entries.map(e => e.alias)) + ' (code-unit order, not localeCompare)');
check('11.orderingIsIndependentOfInputOrder', (() => {
  const A = G.normalizeCatalog([
    { alias: 'b', target: { type: 'memory', id: '2' } },
    { alias: 'a', target: { type: 'memory', id: '1' } }
  ]).entries;
  const B = G.normalizeCatalog([
    { alias: 'a', target: { type: 'memory', id: '1' } },
    { alias: 'b', target: { type: 'memory', id: '2' } }
  ]).entries;
  return JSON.stringify(A) === JSON.stringify(B);
})(), 'catalog snapshot must not depend on input order');

/* ══════════════════════════════════════════════════════════════════════
   §3 · 规范化（NFKC / trim / 大小写）
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · normalization');

check('9.nfkcFullWidthFolded', (() => {
  const r = G.normalizeCatalog([{ alias: 'Ｐｒｏｊｅｃｔ－ＩＢ', target: { type: 'memory', id: 'm1' } }]);
  return r.entries.length === 1 && r.entries[0].alias === 'Project-IB';
})(), 'full-width input must fold to the same alias as ASCII');
check('9.nfkcMakesFullWidthAndAsciiEqual', (() => {
  const a = G.normalizeCatalog([{ alias: 'Ｐｒｏｊｅｃｔ', target: { type: 'memory', id: 'm1' } }]).entries[0].alias;
  const b = G.normalizeCatalog([{ alias: 'Project', target: { type: 'memory', id: 'm1' } }]).entries[0].alias;
  return a === b;
})());
check('5.trimAndCollapseWhitespace', (() => {
  const r = G.normalizeCatalog([{ alias: '  显卡   选购  ', target: { type: 'memory', id: 'm1' } }]);
  return r.entries[0].alias === '显卡 选购';
})());
check('10.caseIsPreservedInCatalog', (() => {
  /* 大小写**不**在 catalog 层折叠：catalog 保留用户原样，便于诊断；
     大小写不敏感由匹配层按需施加。 */
  const r = G.normalizeCatalog([{ alias: 'Project-IB', target: { type: 'memory', id: 'm1' } }]);
  return r.entries[0].alias === 'Project-IB';
})(), 'case folding is a matching-layer concern, not a normalization-layer one');
check('10.caseSensitiveAliasesAreDistinct', (() => {
  const r = G.normalizeCatalog([
    { alias: 'GPU', target: { type: 'memory', id: 'm1' } },
    { alias: 'gpu', target: { type: 'memory', id: 'm2' } }
  ]);
  return r.entries.length === 2;
})());

/* ══════════════════════════════════════════════════════════════════════
   §4 · 上限与畸形丢弃
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · limits / malformed');

check('12.maxEntriesEnforced', (() => {
  const many = [];
  for (let i = 0; i < G.MAX_CATALOG_ENTRIES + 25; i++) {
    many.push({ alias: 'a' + String(i).padStart(5, '0'), target: { type: 'memory', id: 'm' + i } });
  }
  const r = G.normalizeCatalog(many);
  return r.entries.length === G.MAX_CATALOG_ENTRIES && r.truncated === true;
})(), 'cap = ' + G.MAX_CATALOG_ENTRIES);
check('12.truncationIsDeterministic', (() => {
  const many = [];
  for (let i = 0; i < G.MAX_CATALOG_ENTRIES + 25; i++) {
    many.push({ alias: 'a' + String(i).padStart(5, '0'), target: { type: 'memory', id: 'm' + i } });
  }
  const a = JSON.stringify(G.normalizeCatalog(many).entries);
  const b = JSON.stringify(G.normalizeCatalog(many.slice().reverse()).entries);
  return a === b;
})(), 'truncation happens after sorting ⇒ same survivors regardless of input order');
check('13.aliasTooLongRejected', (() => {
  const long = 'x'.repeat(G.MAX_ALIAS_CHARS + 1);
  return G.normalizeEntry({ alias: long, target: { type: 'memory', id: 'm1' } }).reason === 'alias-too-long';
})());
check('13.aliasAtLimitAccepted', (() => {
  const exact = 'x'.repeat(G.MAX_ALIAS_CHARS);
  return G.normalizeEntry({ alias: exact, target: { type: 'memory', id: 'm1' } }).ok === true;
})());
check('malformedEntriesDroppedNotThrown', (() => {
  const r = G.normalizeCatalog([null, undefined, 42, 'str', [], { alias: 'ok', target: { type: 'memory', id: 'm1' } }]);
  return r.entries.length === 1 && r.dropped === 5;
})(), JSON.stringify(G.normalizeCatalog([null, undefined, 42, 'str', [], {}]).droppedReasons));
check('malformedKindRejected',
  G.normalizeEntry({ alias: 'x', kind: 'synonym', target: { type: 'memory', id: 'm1' } }).reason === 'unknown-kind');
check('nonArrayCatalogHandled', (() => {
  const r = G.normalizeCatalog('not-an-array');
  return Array.isArray(r.entries) && r.entries.length === 0 && r.dropped === 1;
})());
check('nullCatalogHandled', (() => {
  const r = G.normalizeCatalog(null);
  return Array.isArray(r.entries) && r.entries.length === 0;
})());
check('noTargetGuessing', (() => {
  /* 把 alias 当 id、把 id 当 alias 都必须不被接受 */
  const r1 = G.normalizeEntry({ alias: 'm1', target: { type: 'memory' } });
  const r2 = G.normalizeEntry({ target: { type: 'memory', id: 'm1' } });
  return r1.ok === false && r2.ok === false;
})(), 'the contract must never infer a missing half of the pair');

/* ══════════════════════════════════════════════════════════════════════
   §5 · provider 可用性语义（§6：absent / empty / malformed / error 必须可区分）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · provider availability');

const absent = G.createGlossaryCatalogProvider(null).getEntries({});
check('19.providerAbsentIsUnavailable', absent.available === false && absent.entries.length === 0
  && absent.reason === G.UNAVAILABLE_NOT_CONFIGURED, JSON.stringify(absent));
check('19.providerUndefinedIsUnavailable',
  G.createGlossaryCatalogProvider(undefined).getEntries({}).available === false);
check('19.emptyCatalogProviderIsUnavailable',
  G.createEmptyCatalogProvider().getEntries({}).available === false);

const emptyOk = G.createGlossaryCatalogProvider(() => []).getEntries({});
check('19.providerReturnsEmptyIsAVAILABLE', emptyOk.available === true && emptyOk.entries.length === 0
  && emptyOk.reason === null, JSON.stringify(emptyOk));

const malformedOk = G.createGlossaryCatalogProvider(() => [{ bad: 1 }, null]).getEntries({});
check('19.providerReturnsMalformedIsAVAILABLE', malformedOk.available === true
  && malformedOk.entries.length === 0 && malformedOk.dropped === 2, JSON.stringify(malformedOk));

const threw = G.createGlossaryCatalogProvider(() => { throw new Error('boom'); }).getEntries({});
check('20.sourceErrorIsUnavailableNotEmptySuccess', threw.available === false
  && threw.reason === G.UNAVAILABLE_ERROR, JSON.stringify(threw));

const badResult = G.createGlossaryCatalogProvider(() => 'nope').getEntries({});
check('20.nonArrayResultIsUnavailable', badResult.available === false
  && badResult.reason === G.UNAVAILABLE_BAD_RESULT, JSON.stringify(badResult));

check('20.promiseResultIsUnavailableNotEmpty', (() => {
  const r = G.createGlossaryCatalogProvider(() => Promise.resolve([])).getEntries({});
  return r.available === false && r.reason === G.UNAVAILABLE_BAD_RESULT;
})(), 'an async source must not masquerade as an empty catalog — "not loaded yet" != "no terms"');

check('19.absentAndEmptyAreDistinguishable',
  absent.available !== emptyOk.available,
  'A(absent) and B(empty) MUST differ — otherwise "the term list is empty" reads as "this channel is unimplemented"');
check('19.malformedAndAbsentAreDistinguishable',
  malformedOk.available !== threw.available);
check('providerIsConfiguredFlag', (() => {
  return G.createGlossaryCatalogProvider(() => []).isConfigured() === true
    && G.createGlossaryCatalogProvider(null).isConfigured() === false;
})());
check('providerConsumesInjectedDataOnly', (() => {
  /* pure-data boundary：provider 只消费调用方给的数据，context 原样透传 */
  let seen = null;
  const p = G.createGlossaryCatalogProvider(ctx => { seen = ctx; return []; });
  const ctx = { apiId: 'role_a', conversationId: 'dm:role_a' };
  p.getEntries(ctx);
  return seen === ctx;
})());
check('providerNeverThrows', (() => {
  const hostile = [
    G.createGlossaryCatalogProvider(() => ({})),
    G.createGlossaryCatalogProvider(() => 42),
    G.createGlossaryCatalogProvider(() => [Symbol.iterator ? 'x' : 'y']),
    G.createGlossaryCatalogProvider(() => { throw 'string-throw'; })
  ];
  try { hostile.forEach(p => p.getEntries({})); return true; } catch (e) { return false; }
})());

/* ══════════════════════════════════════════════════════════════════════
   §6 · 确定性 / 纯函数静态证明
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · determinism / purity');

check('deterministicAcrossRuns', (() => {
  const input = [
    { alias: '显卡', kind: 'term', target: { type: 'memory', id: 'm1' } },
    { alias: 'GPU', target: { type: 'memory', id: 'm2' } },
    { alias: '显卡', target: { type: 'memory', id: 'm3' } }
  ];
  const a = JSON.stringify(G.normalizeCatalog(input));
  for (let i = 0; i < 200; i++) if (JSON.stringify(G.normalizeCatalog(input)) !== a) return false;
  return true;
})());
check('doesNotMutateInput', (() => {
  const input = [{ alias: ' a ', target: { type: 'memory', id: 'm1' } }];
  const snap = JSON.stringify(input);
  G.normalizeCatalog(input);
  return JSON.stringify(input) === snap;
})());

const SRC = fs.readFileSync(path.join(ROOT, REL), 'utf8');
const BARE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
[
  ['14.noDB', /\bindexedDB\b|\bdbGetAll\b|\bdbPut\b|\bdbGet\b|IDBDatabase/],
  ['15.noStorage', /\blocalStorage\b|\bsessionStorage\b/],
  ['16.noFetch', /\bfetch\s*\(|XMLHttpRequest/],
  ['17.noLLM', /\bmiddleBrain\b|\bcallApi\b|openai|anthropic/i],
  ['18.noVector', /\bembedding\b|\bfaiss\b|\bchroma\b|\bqdrant\b|\bbm25\b|\bvector\b/i],
  ['noClock', /Date\s*\.\s*now\s*\(|new\s+Date\s*\(/],
  ['noRandom', /Math\s*\.\s*random\s*\(/],
  ['noConsole', /\bconsole\s*\./],
  ['noDOM', /\bdocument\s*\.|\bwindow\s*\./]
].forEach(([label, re]) => check(label, !re.test(BARE), label + ' must not appear'));
check('noDBModuleImport', !/require\s*\(/.test(BARE), 'the module must not require anything');
check('noLocaleCompare', !/localeCompare/.test(BARE), 'locale-dependent ordering would be non-deterministic');
check('noTitleTagDerivation', !/\btags\b|\btitle\b|\bcontent\b/.test(BARE.replace(/MAX_ALIAS_CHARS/g, '')),
  'aliases must never be derived from title / tags / content');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL GLOSSARY CATALOG FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL GLOSSARY CATALOG PASSED · ' + passed + ' assertions green');
}
