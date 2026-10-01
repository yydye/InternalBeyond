'use strict';
/* Internal Beyond · P21-R2-E1b · Glossary Retrieval（Node，零依赖）
   运行：node tests/test_memory_recall_glossary.js

   被测：glossary-catalog.js（E1a）+ glossary-match.js（E1b）+ orchestrator 的
        glossary 通道与 §6 的**顺序安全**（ACL 先于 target 暴露）。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const GC = require(path.join(ROOT, 'assets/js/memory-recall/glossary-catalog.js'));
const GM = require(path.join(ROOT, 'assets/js/memory-recall/glossary-match.js'));
const Q = require(path.join(ROOT, 'assets/js/memory-recall/recall-query.js'));

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1750000000000, DAY = 86400000;
const mk = o => Object.assign({ id: 'm', title: '记录', content: '正文', importance: 5, arousal: .3,
  resolved: false, activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
  visibility: 'public', tags: [], domain: '日常' }, o || {});
const BASE = { apiId: 'role_a', now: NOW, random: () => .42, isGroup: false, groupMemEnabled: false, maxChars: 2000, contentLen: 200 };
const T = extra => Object.assign({ conversationSignalAvailable: true, isFirstTurn: false, conversationId: 'dm:role_a' }, extra || {});

const prov = entries => GC.createGlossaryCatalogProvider(() => entries);
const ALIAS = (a, id, kind) => ({ alias: a, kind: kind || 'term', target: { type: 'memory', id: id } });

const RECS = [
  mk({ id: 'basement', title: '地下室', content: '关于地下室的一切', importance: 8 }),
  mk({ id: 'gpu', title: '显卡', content: 'RTX 5070 Ti' }),
  mk({ id: 'secret', title: '秘密', content: '不该被看到的', visibility: 'private' }),
  mk({ id: 'onlyMe', title: '仅我可见', content: 'only', visibility: 'only', visibleTo: ['role_a'] }),
  mk({ id: 'notMe', title: '不可见', content: 'nope', visibility: 'except', excludeFrom: ['role_a'] }),
  mk({ id: 'pin', title: '置顶', content: '锚点', pinned: true })
];

function run(msg, opts, turnExtra) {
  return ORCH.recall(RECS, Object.assign({}, BASE, { userMessage: msg },
    { turn: Object.assign({ message: msg }, T(turnExtra || {})) }, opts || {}));
}
const P = prov([ALIAS('地下室', 'basement')]);

/* ══ §1 · 匹配语义（1–4, 18）══ */
section('§1 · 匹配');
const hit = GM.matchGlossary('我们去地下室看看吧', GC.createGlossaryCatalogProvider(() => [ALIAS('地下室', 'basement')]).getEntries({}));
check('1.exactAliasHit', hit.available === true && hit.hits.length === 1 && hit.hits[0].memoryIds[0] === 'basement', JSON.stringify(hit.hits));
check('2.exactTermKindReported', hit.byMemoryId.basement.reasons.indexOf('exact-term') >= 0, JSON.stringify(hit.byMemoryId));
const aliasKind = GM.matchGlossary('地下室', GC.createGlossaryCatalogProvider(() => [ALIAS('地下室', 'basement', 'alias')]).getEntries({}));
check('2.exactAliasKindReported', aliasKind.byMemoryId.basement.reasons.indexOf('exact-alias') >= 0);
check('3.quotedExact', (() => {
  const r = GM.matchGlossary('他说「地下室」很冷', P.getEntries({}));
  return r.hits.length === 1 && r.hits[0].quoted === true && r.byMemoryId.basement.reasons.indexOf('quoted-exact') >= 0;
})());
check('4.caseFoldComesFromUniqueMatcher', (() => {
  /* P21-R2-E1b.1 §9 情况 A：唯一 matcher 已升级为 ASCII case-folded。
     glossary-match **不得**自行 lowercase —— 它必须原样继承唯一 matcher 的语义。 */
  const up = GC.createGlossaryCatalogProvider(() => [ALIAS('Project-IB', 'gpu', 'alias')]).getEntries({});
  const exact = GM.matchGlossary('Project-IB 是项目', up);
  const lower = GM.matchGlossary('project-ib 是项目', up);
  const mixed = GM.matchGlossary('ProJect-Ib 是项目', up);
  return exact.hits.length === 1 && lower.hits.length === 1 && mixed.hits.length === 1;
})(), 'both cases must hit — via the unique matcher, not a local copy');
check('4.glossaryMatchHasNoLocalCaseLogic', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/glossary-match.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/toLowerCase|toUpperCase|toLocaleLowerCase|foldAscii/.test(src);
})(), 'a second case rule here would fork recall and glossary semantics');
check('4.nfkcFoldingStillWorks', (() => {
  const up = GC.createGlossaryCatalogProvider(() => [ALIAS('Ｐｒｏｊｅｃｔ', 'gpu', 'alias')]).getEntries({});
  return GM.matchGlossary('Ｐｒｏｊｅｃｔ 是项目', up).hits.length === 1;
})());

/* ══ §2 · 反例（5–7, 18）══ */
section('§2 · 反例');
check('5.unknownAliasNoHit', GM.matchGlossary('量子纠缠', P.getEntries({})).hits.length === 0);
check('18.quotedDoesNotInventHit', (() => {
  const r = GM.matchGlossary('他说「一个完全不存在的词」', P.getEntries({}));
  return r.available === true && r.hits.length === 0;
})(), 'quoting a non-existent term must never create a hit');
check('6.substringFalsePositiveRejected', (() => {
  const up = GC.createGlossaryCatalogProvider(() => [ALIAS('IB', 'gpu', 'alias')]).getEntries({});
  return GM.matchGlossary('IBX 是另一种东西', up).hits.length === 0;
})());
check('6.asciiWordBoundaryBlocksInnerSubstring', (() => {
  /* `IB` 不得在 `IBX` 内命中（右侧是 wordish 字符）。 */
  const up = GC.createGlossaryCatalogProvider(() => [ALIAS('IB', 'gpu', 'alias')]).getEntries({});
  return GM.matchGlossary('IBX 是另一种东西', up).hits.length === 0;
})());
check('7.DEBT_fileAdjacencyReachesGlossary', (() => {
  /* DEBT R2-E1b-ALIAS-BOUNDARY-1 · 端到端后果，**显式钉住**。
     唯一 matcher 的 ASCII 词边界只排除 wordish 字符，`.` 不是 ⇒ `README`
     会在 `README.md` 中命中，于是 glossary 通道也会因此命中对应 memory。
     审计结论：MEMORY_RECALL_CONTRACT.md 从未规定 alias 不得命中文件名/域名
     ⇒ E1b.1 **不**改这条语义（改它就是在无 contract 依据下偷改唯一 matcher）。
     在 glossary 层补 `.md` / dot guard 更是§4 明令禁止的第二套 matcher。
     这里断言的是"当前真实行为"，所以任何一方偷偷改变它都会让本测试失败。 */
  const up = GC.createGlossaryCatalogProvider(() => [ALIAS('README', 'gpu', 'alias')]).getEntries({});
  return GM.matchGlossary('see README.md for details', up).hits.length === 1;
})(), 'DEBT R2-E1b-ALIAS-BOUNDARY-1: file adjacency matches, and that is asserted on purpose');
check('7.noLocalDotGuardInGlossaryMatch', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/glossary-match.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/dotGuard|fileExt|extension|isDomain/.test(src);
})(), 'no per-glossary boundary patch is permitted');
/* ── §11 · matcher parity 矩阵 ────────────────────────────────────────
   核心不变量：对同一 text / catalog，
       glossary hits 的 alias 集合  ===  buildRecallQuery(text,{aliases}).aliases 的 alias 集合
   逐项一致。glossary **不**拥有第二套匹配规则，因此结构上不可能引入
   额外命中或漏掉命中。覆盖 §11 要求的全部维度。 */
check('P1.matcherParityAcrossDimensions', (() => {
  const entries = [
    ALIAS('地下室', 'basement'),            /* CJK */
    ALIAS('Project-IB', 'proj', 'alias'),   /* ASCII case + hyphen */
    ALIAS('memory_records', 'mr', 'alias'), /* underscore */
    ALIAS('IB', 'ib', 'alias'),             /* 短 ASCII，边界敏感 */
    ALIAS('README', 'readme', 'alias'),     /* 文件名债务 */
    ALIAS('example', 'ex', 'alias'),        /* 域名债务 */
    ALIAS('user', 'usr', 'alias'),          /* 邮箱债务 */
    ALIAS('docs', 'dcs', 'alias')           /* 路径债务 */
  ];
  const cat = GC.createGlossaryCatalogProvider(() => entries).getEntries({});
  const refAliases = entries.map(e => ({ alias: e.alias, target: e.target.id }));
  const texts = [
    '我们去地下室看看吧',                       /* CJK 顺带提及 */
    '他说《地下室》很冷',                       /* CJK quoted */
    'project-ib 是项目',                       /* ASCII 小写 */
    'PROJECT-IB 是项目',                       /* ASCII 大写 */
    'ProJect-Ib 是项目',                       /* ASCII 混合 */
    'check memory_records now',                /* underscore */
    'memory_recordsX is another thing',        /* underscore 边界反例 */
    'IBX 是另一种东西',                         /* 短别名边界反例 */
    'IB 就是本项目',                            /* 短别名正例 */
    'see README.md for details',               /* 文件名债务 */
    'visit example.com',                       /* 域名债务 */
    'write to user@example.com',               /* 邮箱债务 */
    'open /docs/readme now',                   /* 路径债务 */
    '完全无关的一句话'                          /* 零命中 */
  ];
  const mismatches = [];
  for (const t of texts) {
    const mine = GM.matchGlossary(t, cat).hits.map(h => h.alias).sort();
    const ref = Q.buildRecallQuery(t, { aliases: refAliases }).aliases.map(a => a.alias).sort();
    if (JSON.stringify(mine) !== JSON.stringify(ref)) mismatches.push({ t, mine, ref });
  }
  if (mismatches.length) console.error('  parity mismatches: ' + JSON.stringify(mismatches));
  return mismatches.length === 0;
})(), 'glossary matcher must be the SAME matcher as the recall query matcher');
check('P2.parityCoversCaseFold', (() => {
  const cat = GC.createGlossaryCatalogProvider(() => [ALIAS('Project-IB', 'proj', 'alias')]).getEntries({});
  return GM.matchGlossary('project-ib', cat).hits.length === 1
    && GM.matchGlossary('PROJECT-IB', cat).hits.length === 1;
})(), 'case folding must be visible through the glossary channel too');
check('P3.parityCoversBoundary', (() => {
  const cat = GC.createGlossaryCatalogProvider(() => [ALIAS('IB', 'ib', 'alias')]).getEntries({});
  return GM.matchGlossary('IBX', cat).hits.length === 0
    && GM.matchGlossary('IB here', cat).hits.length === 1;
})());
check('P4.glossaryDoesNotAddExtraFalsePositives', (() => {
  const cat = GC.createGlossaryCatalogProvider(() => [ALIAS('地下室', 'basement'), ALIAS('IB', 'ib', 'alias')]).getEntries({});
  return GM.matchGlossary('完全无关', cat).hits.length === 0
    && GM.matchGlossary('IBX 不是', cat).hits.length === 0;
})());

/* ══ §3 · 多 target / 去重（8–9）══ */
section('§3 · 多 target');
check('8.multipleAliasesSameTargetDeduped', (() => {
  const up = prov([ALIAS('地下室', 'basement'), ALIAS('地下', 'basement')]).getEntries({});
  const r = GM.matchGlossary('地下室和地下', up);
  const ids = new Set();
  r.hits.forEach(h => h.memoryIds.forEach(i => ids.add(i)));
  return r.hits.length === 2 && ids.size === 1;
})());
check('9.sameAliasMultipleTargetsAllPassedToSelector', (() => {
  const up = prov([ALIAS('地下室', 'basement'), ALIAS('地下室', 'gpu')]).getEntries({});
  const r = GM.matchGlossary('地下室', up);
  return r.hits.length === 1 && r.hits[0].memoryIds.length === 2;
})(), 'catalog must NOT pick a winner — all visible targets go to the canonical selector');
check('9.noWinnerByCatalogOrderOrAlphabet', (() => {
  /* 两个 target 顺序在 catalog 里互换 ⇒ 结果集合必须相同（只由 core 排序）。 */
  const a = run('地下室', { glossaryProvider: prov([ALIAS('地下室', 'basement'), ALIAS('地下室', 'gpu')]) });
  const b = run('地下室', { glossaryProvider: prov([ALIAS('地下室', 'gpu'), ALIAS('地下室', 'basement')]) });
  return JSON.stringify(a.result.selected.map(s => s.id)) === JSON.stringify(b.result.selected.map(s => s.id));
})());

/* ══ §4 · ACL 顺序安全（10–11）══ */
section('§4 · ACL 顺序');
check('10.hiddenTargetNotInjected', (() => {
  const r = run('地下室', { glossaryProvider: prov([ALIAS('地下室', 'secret')]) });
  return r.result.count === 0 && r.result.selected.length === 0;
})());
check('10.hiddenTargetAbsentFromTrace', (() => {
  const r = run('地下室', { glossaryProvider: prov([ALIAS('地下室', 'secret')]) });
  const ids = r.trace.candidates.map(c => c.memoryId);
  const raw = JSON.stringify(r.trace);
  return ids.indexOf('secret') < 0 && raw.indexOf('secret') < 0 && raw.indexOf('不该被看到') < 0;
})(), 'a hidden target must not be exposed through alias existence, id, title or content');
check('11.onlyVisibleTargetWorks', (() => {
  const r = run('地下室', { glossaryProvider: prov([ALIAS('地下室', 'onlyMe')]) });
  return r.result.selected.map(s => s.id).join(',') === 'onlyMe';
})());
check('11.exceptHiddenTargetWorks', (() => {
  const r = run('地下室', { glossaryProvider: prov([ALIAS('地下室', 'notMe')]) });
  return r.result.count === 0;
})());

/* ══ §5 · provider 语义（12–16）══ */
section('§5 · provider');
check('12.providerAbsentForcedGlossaryUnsupported', (() => {
  const r = run('地下室', {}, { channelHint: 'glossary' });
  return r.result.reason === 'channel-unsupported' && r.meta.channelImplemented === true;
})());
check('13.providerAbsentOrdinaryMessageIsSurface', (() => {
  const r = run('完全无关的一句话');
  return r.trace.channel === 'surface';
})());
check('14.providerAvailableEmptyOrdinaryIsSurface', (() => {
  const r = run('地下室', { glossaryProvider: prov([]) });
  return r.trace.channel === 'surface';
})());
check('15.providerAvailableEmptyForcedIsZeroHitNotUnsupported', (() => {
  const r = run('地下室', { glossaryProvider: prov([]) }, { channelHint: 'glossary' });
  return r.trace.channel === 'glossary' && r.result.reason !== 'channel-unsupported'
    && r.result.count === 0;
})());
check('16.malformedEntriesDropped', (() => {
  const up = GC.createGlossaryCatalogProvider(() => [null, 42, { alias: 'x' }, { alias: '', target: { type: 'memory', id: 'a' } }, ALIAS('地下室', 'basement')]).getEntries({});
  return up.available === true && up.entries.length === 1 && GM.matchGlossary('地下室', up).hits.length === 1;
})());
check('16.providerThrowsIsUnavailable', (() => {
  const up = GC.createGlossaryCatalogProvider(() => { throw new Error('boom'); }).getEntries({});
  const r = GM.matchGlossary('地下室', up);
  return r.available === false && r.hits.length === 0 && typeof r.reason === 'string';
})());

/* ══ §6 · 自动通道（17, 19, 20）══ */
section('§6 · 自动通道 / trace');
check('17.deterministic', (() => {
  const a = JSON.stringify(run('地下室', { glossaryProvider: P }).result);
  for (let i = 0; i < 50; i++) if (JSON.stringify(run('地下室', { glossaryProvider: P }).result) !== a) return false;
  return true;
})());
check('19.traceReasonsForGlossary', (() => {
  const r = run('他说「地下室」很冷', { glossaryProvider: P });
  const sel = r.trace.candidates.filter(c => c.decision === 'selected');
  return r.trace.channel === 'glossary' && sel.length === 1
    && sel[0].reasons.indexOf('exact-term') >= 0 && sel[0].reasons.indexOf('quoted-exact') >= 0;
})());
check('19.traceChannelIsGlossary', run('地下室', { glossaryProvider: P }).trace.channel === 'glossary');
check('20.targetIsStableMemoryId', (() => {
  const r = run('地下室', { glossaryProvider: P });
  return r.result.selected.length === 1 && r.result.selected[0].id === 'basement'
    && r.trace.candidates.some(c => c.memoryId === 'basement' && c.decision === 'selected');
})());
check('20.noSecondLexicalGate', (() => {
  /* alias 命中但 memory 正文**不含** alias 时仍必须进入 selected。 */
  const recs = [mk({ id: 'code', title: '暗号甲', content: '与别名毫无字面重叠' })];
  const r = ORCH.recall(recs, Object.assign({}, BASE, { userMessage: '地下室' },
    { glossaryProvider: prov([ALIAS('地下室', 'code')]) },
    { turn: Object.assign({ message: '地下室' }, T()) }));
  return r.trace.channel === 'glossary' && r.result.selected.map(s => s.id).join(',') === 'code';
})(), 'exact catalog hit IS the admission evidence — a second lexical gate would wrongly reject it');

/* ══ §7 · 纯函数 / 无第二套（21–23, 24, 25）══ */
section('§7 · 纯度 / shape');
const GMSRC = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/glossary-match.js'), 'utf8');
const BARE = GMSRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
check('21.reusesUniqueMatcher', /matchAliases/.test(BARE) && /normalizeAliasEntries/.test(BARE)
  && /findProtectedSpans/.test(BARE) && /normalizeText/.test(BARE));
check('21.noSecondAliasMatcher', !/localeCompare|charCodeAt|codePointAt|isWordishChar/.test(BARE),
  'boundary / quoted / folding logic must not be re-implemented here');
check('22.noDB', !/indexedDB|dbGetAll|dbPut|dbGet\b/.test(BARE));
check('23.noLLMVectorNetwork', !/middleBrain|callApi|fetch\s*\(|XMLHttpRequest|embedding|faiss|chroma|qdrant|bm25|vector/i.test(BARE));
check('23.noClockNoRandom', !/Date\s*\.\s*now|Math\s*\.\s*random/.test(BARE));
check('24.glossaryActivationIsNormal', (() => {
  const r = run('地下室', { glossaryProvider: P });
  return r.meta.activationPolicy === 'normal';
})(), 'user explicitly mentioned the term ⇒ normal reinforcement');
check('25.resultShapeUnchanged', (() => {
  const r = run('地下室', { glossaryProvider: P }).result;
  return JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['chars', 'count', 'reason', 'selected', 'text']);
})(), 'no activationPolicy / shouldActivate / suppressActivation on the canonical result');
check('25.metaCarriesActivationPolicyOnly', (() => {
  const r = run('地下室', { glossaryProvider: P });
  return r.meta.activationPolicy === 'normal' && r.meta.trace === undefined && r.meta.candidates === undefined;
})(), 'trace must not leak into meta');
check('25.budgetSharedSingleBlock', (() => {
  const r = run('地下室', { glossaryProvider: P });
  return r.result.chars <= BASE.maxChars;
})());

console.log('\n' + '='.repeat(64));
if (failures) { console.error('MEMORY RECALL GLOSSARY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL GLOSSARY PASSED · ' + passed + ' assertions green');
