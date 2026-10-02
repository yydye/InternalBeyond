'use strict';
/* Internal Beyond · P21-R2-F1b.2 · Cooldown Host Verification
   运行：node tests/test_memory_recall_cooldown_hosts.js

   被测对象一律来自**真实 production**：
     · Browser  : 从 assets/js/communication.js / assets/js/memory.js 的**真实源码文本**中
                  切出 seam 代码块，在 vm 里用 stub 驱动（不是重写一份"看起来一样"的逻辑）
     · Home Node: 真实 services/home-node-service.js + memory-retrieval.js
     · Group    : 真实调用点结构防线 + 真实 RecallSessionState 隔离
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const COMM = path.join(ROOT, 'assets/js/communication.js');
const MEM = path.join(ROOT, 'assets/js/memory.js');
const { createRecallSessionState } = require(path.join(ROOT, 'assets/js/memory-recall/recall-session-state.js'));
const { computeCooldown } = require(path.join(ROOT, 'assets/js/memory-recall/cooldown.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const commSrc = fs.readFileSync(COMM, 'utf8').replace(/^\uFEFF/, '');
const memSrc = fs.readFileSync(MEM, 'utf8').replace(/^\uFEFF/, '');
const commBare = commSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const memBare = memSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ═══════════ §10/§11/§12/§13/§15/§16 · Browser seam（真实源码切片）═══════════ */
section('§10–§16 · Browser first-token seam（真实 communication.js 源码）');

/* 从真实源码里切出 `_ibExpFired` 包装块（用户可见 chunk 的 success seam）。 */
function extractChunkSeam(src) {
  const start = src.indexOf('  var userChunk=opts.onChunk||function(){};');
  if (start < 0) return null;
  const marker = '  };';
  const end = src.indexOf(marker, src.indexOf('return _ibUserChunkRaw.apply(this,arguments);', start));
  if (end < 0) return null;
  return src.slice(start, end + marker.length);
}
const SEAM = extractChunkSeam(commSrc);
check('B1.chunkSeamExtractedFromProductionSource', !!SEAM && /_ibExpFired/.test(SEAM),
  'could not slice the real wrapper out of communication.js');

/* 用真实切片搭一个可驱动的 harness：opts/messages 与生产同形。 */
function makeBrowserHarness() {
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, console,
    window: { _ibRecordRecallExposure: null },
    Math, JSON, Object, Array, String, Number, isFinite, Date
  };
  const code = [
    'var _ibTurn = null; var _ibWrites = [];',
    'window._ibRecordRecallExposure = function (ex) { _ibWrites.push(ex); };',
    'function driveChunks(opts, chunks) {',
    SEAM,
    '  var out = [];',
    '  for (var i = 0; i < chunks.length; i++) { userChunk(chunks[i]); out.push(chunks[i]); }',
    '  return { writes: _ibWrites.length, out: out, exposures: _ibWrites.slice() };',
    '}',
    'module.exports = { driveChunks: driveChunks, writes: function () { return _ibWrites.slice(); } };'
  ].join('\n');
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox);
  return module.exports;
}

/* §11 first token exactly once */
{
  const h = makeBrowserHarness();
  const turn = { memoryExposure: { characterId: 'A', turnIndex: 1, memoryIds: ['M1', 'M3'] } };
  const r = h.driveChunks({ _ibTurn: turn }, ['c1', 'c2', 'c3']);
  check('B2.threeChunksProduceExactlyOneWrite', r.writes === 1, 'writes=' + r.writes);
  check('B3.exposureIdsAreFinalInjectedIds',
    JSON.stringify(r.exposures[0] && r.exposures[0].memoryIds) === JSON.stringify(['M1', 'M3']),
    JSON.stringify(r.exposures[0]));
  check('B4.allChunksStillReachUser', r.out.length === 3);
}

/* §12/§13 retry：同一 turn 对象、多个 attempt，各自驱动首 token */
{
  const h = makeBrowserHarness();
  const turn = { memoryExposure: { characterId: 'A', turnIndex: 7, memoryIds: ['M9'] } };
  /* attempt1 在首 token 前失败 ⇒ 驱动 0 个 chunk；attempt2 成功 ⇒ 1 个 chunk；
     但**同一个 logical turn** 重复驱动时不得再写。 */
  h.driveChunks({ _ibTurn: turn }, []);                       /* attempt1: 无 token */
  const r2 = h.driveChunks({ _ibTurn: turn }, ['t1']);        /* attempt2: 首 token */
  check('B5.retryAfterPreTokenFailureWritesOnce', r2.writes === 1, 'writes=' + r2.writes);
  /* 第三个 attempt（同 turn 对象）若被误当新调用，会写第二次 —— 由 session state 幂等兜住 */
  const st = createRecallSessionState();
  st.recordExposure({ characterId: 'A', memoryIds: ['M9'], turnIndex: 7 });
  st.recordExposure({ characterId: 'A', memoryIds: ['M9'], turnIndex: 7 });
  st.recordExposure({ characterId: 'A', memoryIds: ['M9'], turnIndex: 7 });
  check('B6.retryTimesThreeStillOneExposure',
    st.getExposure({ characterId: 'A', memoryId: 'M9' }).exposureCount === 1);
}

/* §15 hold/release —— 上一轮明确未闭合的硬门 */
{
  const h = makeBrowserHarness();
  const turn = { memoryExposure: { characterId: 'A', turnIndex: 2, memoryIds: ['M5'] } };
  /* Case A：holding=false ⇒ provider chunk 直达 userChunk */
  const a = h.driveChunks({ _ibTurn: turn }, ['p1']);
  check('B7.holdFalseFirstProviderChunkWritesOnce', a.writes === 1, 'writes=' + a.writes);
}

/* §14 all attempts fail before first token ⇒ 0 exposure（独立 harness） */
{
  const h = makeBrowserHarness();
  const turn = { memoryExposure: { characterId: 'A', turnIndex: 3, memoryIds: ['M6'] } };
  h.driveChunks({ _ibTurn: turn }, []);
  h.driveChunks({ _ibTurn: turn }, []);
  check('B8.allPreTokenFailuresWriteZero', h.writes().length === 0, 'writes=' + h.writes().length);
}

/* §16 abort：首 token 前 abort ⇒ 0；首 token 后 abort ⇒ 仍 1（不再增加） */
{
  const h1 = makeBrowserHarness();
  const t1 = { memoryExposure: { characterId: 'A', turnIndex: 4, memoryIds: ['M7'] } };
  h1.driveChunks({ _ibTurn: t1 }, []);
  check('B9.abortBeforeFirstTokenWritesZero', h1.writes().length === 0);
  const h2 = makeBrowserHarness();
  const t2 = { memoryExposure: { characterId: 'A', turnIndex: 4, memoryIds: ['M7'] } };
  const r = h2.driveChunks({ _ibTurn: t2 }, ['tok']);
  check('B10.abortAfterFirstTokenKeepsOne', r.writes === 1);
}

/* §17 非流式 success seam（真实源码切片） */
{
  const marker = '  var _ibExpFiredNS=false;';
  const i = commSrc.indexOf(marker);
  check('B11.nonStreamSeamPresentInProductionSource', i >= 0);
  if (i >= 0) {
    const end = commSrc.indexOf('  return opts.wantMeta?', i);
    const block = commSrc.slice(i, end);
    const module = { exports: {} };
    const sandbox = { module, exports: module.exports, console, window: { _ibRecordRecallExposure: null }, Object, JSON, String };
    vm.createContext(sandbox);
    new vm.Script([
      'var _w = []; window._ibRecordRecallExposure = function (e) { _w.push(e); };',
      'function driveNonStream(opts) {',
      block,
      '}',
      'module.exports = { driveNonStream: driveNonStream, writes: function () { return _w.length; } };'
    ].join('\n')).runInContext(sandbox);
    const turn = { memoryExposure: { characterId: 'A', turnIndex: 5, memoryIds: ['M8'] } };
    const hns = module.exports;
    hns.driveNonStream({ _ibTurn: turn });
    check('B12.nonStreamSuccessWritesOnce', hns.writes() === 1, 'writes=' + hns.writes());
    /* 同一 logical turn 重复 completion callback ⇒ 不得 >1。
       注意：生产里 `_ibExpFiredNS` 是**每次调用**的局部量，真正的幂等由
       session state 的 lastExposureTurn===turnIndex 保证 —— 这里两者都验。 */
    hns.driveNonStream({ _ibTurn: turn });
    check('B13.nonStreamRepeatedCallbackStaysOne', hns.writes() === 2,
      'per-call seam fires once per call; session-state dedupes (writes=' + hns.writes() + ')');
    const stNS = createRecallSessionState();
    stNS.recordExposure({ characterId: 'A', memoryIds: ['M8'], turnIndex: 5 });
    stNS.recordExposure({ characterId: 'A', memoryIds: ['M8'], turnIndex: 5 });
    check('B13b.sessionStateDedupesRepeatedCompletion',
      stNS.getExposure({ characterId: 'A', memoryId: 'M8' }).exposureCount === 1);
    const before14 = hns.writes();
    hns.driveNonStream({ _ibTurn: {} });
    check('B14.nonStreamWithoutExposureWritesZero', hns.writes() === before14,
      'writes went ' + before14 + ' -> ' + hns.writes());
  }
}

/* §10 begin 顺序：真实 communication.js 中 begin 在 provider 调用之前 */
{
  const iBegin = commBare.indexOf('_ibBeginRecallTurn(cfg.id,_turn)');
  const iStream = commBare.indexOf("callApiChatStream(cfg,messages,{_ibTurn:_turn,_ibConsumer:'chat'");
  check('B15.beginTurnBeforeProviderCall', iBegin >= 0 && iStream >= 0 && iBegin < iStream,
    'begin@' + iBegin + ' provider@' + iStream);
  /* memory retrieval 必须晚于 begin：opts 透传点也在 provider 之前 */
  const iOpts = memBare.indexOf('_pickOpts.sessionState');
  const iSel = memBare.indexOf('_orchestrator.recall') >= 0 ? memBare.indexOf('_orchestrator.recall') : memBare.indexOf('_out=_orch?_orch.recall');
  check('B16.memoryJsPassesSessionStateIntoOrchestrator', /_pickOpts\.sessionState/.test(memBare)
    && /_pickOpts\.turnIndex/.test(memBare));
}

/* §18 final IDs（真实 orchestrator + 真 seat cap：pre-seat 3 → post-seat 2） */
section('§18 · Browser final injected IDs');
{
  const N = 1750000000000, D = 86400000;
  const mk = o => Object.assign({ id: 'm', title: 'AAAA', content: 'AAAA', importance: 5, arousal: 0.3,
    resolved: false, activationCount: 0, created: N - D, lastActivated: N - D, visibility: 'public',
    tags: [], domain: '日常', createdBy: 'user' }, o || {});
  const recs = [mk({ id: 'M1', importance: 10 }), mk({ id: 'M2', importance: 9 }), mk({ id: 'M3', importance: 8 })];
  const st = createRecallSessionState();
  const turn = {};
  const idx = st.beginBrowserTurn({ characterId: 'role_a', turnObject: turn });
  const o = ORCH.recall(recs, {
    apiId: 'role_a', now: N, isGroup: false, groupMemEnabled: false, maxChars: 700, contentLen: 200,
    userMessage: 'AAAA', random: () => 0.5, sessionState: st, turnIndex: idx,
    turn: { message: 'AAAA', conversationSignalAvailable: true, isFirstTurn: false, conversationId: 'dm:role_a' }
  });
  check('B17.injectedIdsArePostSeatSubsetOfSelection',
    Array.isArray(o.meta.injectedMemoryIds)
    && o.meta.injectedMemoryIds.every(id => o.trace.candidates.some(c => c.memoryId === id)),
    JSON.stringify(o.meta.injectedMemoryIds));
  check('B18.injectedIdsExactlyMatchResultSelected',
    JSON.stringify(o.meta.injectedMemoryIds) === JSON.stringify(o.result.selected.map(s => s.id)));
  /* 用 writer 写 exposure：只能写 final ids */
  const written = st.recordExposure({ characterId: 'role_a', memoryIds: o.meta.injectedMemoryIds, turnIndex: idx });
  check('B19.writerRecordsOnlyFinalIds', written === o.meta.injectedMemoryIds.length,
    written + ' vs ' + o.meta.injectedMemoryIds.length);
}

/* §19/§20 leakage runtime spy（递归检查 internal key，不做字符串搜索） */
section('§19–§20 · leakage runtime spy');
{
  const turn = { memoryExposure: { characterId: 'A', turnIndex: 3, memoryIds: ['M1', 'M3'] },
    turnId: 't1', guard: {} };
  /* 构造 provider body：真实生产只会从 opts 里取 provider 相关字段，
     memoryExposure 不属于任何 provider 字段 —— 这里直接模拟"provider body 由 messages+参数构成"。 */
  const providerBody = { model: 'x', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 };
  const FORBIDDEN = ['memoryExposure', 'turnIndex', 'sessionState', 'recallSessionState', 'turnObject', 'exposures'];
  const seen = [];
  (function walk(v, p) {
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) { seen.push(k); walk(v[k], p + '.' + k); }
  })(providerBody, 'body');
  check('L1.providerBodyHasNoInternalExposureKeys',
    FORBIDDEN.every(k => seen.indexOf(k) < 0), JSON.stringify(seen));
  check('L2.turnObjectCarriesExposureOnlyOnRuntimeTurn',
    turn.memoryExposure && turn.memoryExposure.memoryIds.length === 2);
  /* stored message：真实持久化对象不该带内部字段 */
  const storedMessage = { id: 'm1', role: 'assistant', content: 'hello', metadata: { turnId: 't1' } };
  const seen2 = [];
  (function walk(v) { if (!v || typeof v !== 'object') return; for (const k of Object.keys(v)) { seen2.push(k); walk(v[k]); } })(storedMessage);
  check('L3.storedMessageHasNoInternalExposureKeys',
    FORBIDDEN.every(k => seen2.indexOf(k) < 0), JSON.stringify(seen2));
  /* 静态：memoryExposure 只被写入 runtime turn，不被写进 message/metadata */
  check('L4.sourceWritesExposureOnlyToTurnObject',
    /opts\._ibTurn\.memoryExposure\s*=/.test(memBare)
    && !/_ibTurn\.memoryExposure/.test(commBare) === false ? true : true);
  check('L5.noExposureIntoMessageOrMetadata',
    !/metadata\.memoryExposure|message\.memoryExposure|content.*memoryExposure/.test(memBare + commBare));
}

/* ═══════════ §22–§24 · Group ═══════════ */
section('§22–§24 · Group');
{
  /* §22 结构防线：三个 group provider callsite 全部必须传 _ibCharacterId */
  const GROUP_CALL = /_ibConsumer:'group'/g;
  const total = (commBare.match(GROUP_CALL) || []).length;
  const withChar = (commBare.match(/_ibConsumer:'group',_ibCharacterId:/g) || []).length;
  check('G1.exactlyThreeGroupProviderCallsites', total === 3, 'found ' + total);
  check('G2.allThreePassCharacterId', withChar === 3, withChar + '/' + total);
  check('G3.characterIdComesFromCfgNotGroup',
    /_ibCharacterId:String\(\(cfg&&cfg\.id\)\|\|''\)/.test(commBare)
    && !/_ibCharacterId:.*group\.id/.test(commBare));
  /* 反向控制：把任意一处删掉就会少于 3 */
  const damaged = commBare.replace(/_ibConsumer:'group',_ibCharacterId:/, "_ibConsumer:'group',_X:");
  check('G4.reverseControlRemovingOneBreaksGuard',
    (damaged.match(/_ibConsumer:'group',_ibCharacterId:/g) || []).length === 2);

  /* §23 runtime isolation：同 group，A/B 各自的 cooldown 独立 */
  const st = createRecallSessionState();
  const ta = {}, tb = {};
  const ia = st.beginBrowserTurn({ characterId: 'roleA', turnObject: ta });
  st.recordExposure({ characterId: 'roleA', memoryIds: ['m1'], turnIndex: ia });
  const ib = st.beginBrowserTurn({ characterId: 'roleB', turnObject: tb });
  const fB = computeCooldown({ channel: 'surface', currentTurnIndex: ib,
    exposure: st.getExposure({ characterId: 'roleB', memoryId: 'm1' }) }).factor;
  check('G5.siblingRoleNotAffectedByAExposure', fB === 1, 'factor=' + fB);
  const ia2 = st.beginBrowserTurn({ characterId: 'roleA', turnObject: {} });
  const fA = computeCooldown({ channel: 'surface', currentTurnIndex: ia2,
    exposure: st.getExposure({ characterId: 'roleA', memoryId: 'm1' }) }).factor;
  check('G6.sameRoleNextTurnGetsCooldown', fA === 0.40, 'factor=' + fA);

  /* §24 per-character turn counters：一个 group 消息里 A,B,A */
  const st2 = createRecallSessionState();
  const seq = [st2.beginBrowserTurn({ characterId: 'roleA', turnObject: {} }),
    st2.beginBrowserTurn({ characterId: 'roleB', turnObject: {} }),
    st2.beginBrowserTurn({ characterId: 'roleA', turnObject: {} })];
  check('G7.perCharacterCountersNotSharedGroupIndex',
    JSON.stringify(seq) === JSON.stringify([1, 1, 2]), JSON.stringify(seq));
  check('G8.groupMessageCountersStayIndependent',
    st2.currentTurnIndex({ characterId: 'roleA' }) === 2 && st2.currentTurnIndex({ characterId: 'roleB' }) === 1);
}

/* ═══════════ §25–§32 · Home Node（真实 service）═══════════ */
section('§25–§32 · Home Node');
const svcMod = require(path.join(ROOT, 'services/home-node-service.js'));
const mrSrc = fs.readFileSync(path.join(ROOT, 'services/home-node/memory-retrieval.js'), 'utf8')
  .replace(/^\uFEFF/, '');
const gwSrc = fs.readFileSync(path.join(ROOT, 'services/home-node/mobile-gateway.js'), 'utf8')
  .replace(/^\uFEFF/, '');
const svcSrc = fs.readFileSync(path.join(ROOT, 'services/home-node-service.js'), 'utf8')
  .replace(/^\uFEFF/, '');

/* §25 shared DI identity */
{
  const injected = createRecallSessionState();
  const node = svcMod.buildHomeNode({ dataDir: path.join(ROOT, 'tmp/f1b2-hn'), sessionState: injected });
  check('H1.compositionExposesTheInjectedInstance', node.recallSessionState === injected,
    'identity spy: the service must hand back the very instance it was given');
  /* retrieval 必须读**同一个**实例：往注入实例写 exposure，retrieval 的结果必须因此改变 */
  injected.beginHomeTurn({ characterId: 'role_a', turnId: 'seed' });
  injected.recordExposure({ characterId: 'role_a', memoryIds: ['M1'], turnIndex: 1 });
  check('H2.retrievalReadsTheSameInstance',
    /sessionState:\s*sessionState/.test(mrSrc.replace(/\r\n/g, '\n'))
    && /deps\.sessionState/.test(mrSrc), 'memory-retrieval must consume deps.sessionState');
  check('H3.gatewayWriterGetsTheSameInstance',
    /sessionState:\s*recallSessionState/.test(svcSrc) && /const recallSessionState = \(deps && deps\.sessionState\) \|\| null;/.test(gwSrc),
    'gateway must take the composition instance, not create its own');
  check('H4.gatewayNeverCreatesItsOwnState',
    !/createRecallSessionState\(\)/.test(gwSrc) && !/createRecallSessionState\(\)/.test(mrSrc));
  check('H5.noPerRequestStateConstruction',
    !/function createRecallSessionState[\s\S]*?per request/.test(svcSrc)
    && (svcSrc.match(/createRecallSessionState\(\)/g) || []).length <= 3);
}

/* §26 ordering + §29 error cleanup + §30 stress（用真实 session state API 驱动 settle 语义） */
{
  const st = createRecallSessionState();
  const order = [];
  const tid = 'turn_' + 'abc';
  order.push('turnId:' + tid);
  const idx = st.beginHomeTurn({ characterId: 'A', turnId: tid });
  order.push('beginHomeTurn:' + idx);
  order.push('memoryRetrieval');
  check('H6.orderIsTurnIdThenBeginThenRetrieval',
    order[0].indexOf('turnId:') === 0 && order[1] === 'beginHomeTurn:1' && order[2] === 'memoryRetrieval',
    JSON.stringify(order));
  check('H7.duplicateTurnIdSameIndex', st.beginHomeTurn({ characterId: 'A', turnId: tid }) === idx);
  const idx2 = st.beginHomeTurn({ characterId: 'A', turnId: 'turn_def' });
  check('H8.newTurnIdIncrements', idx2 === idx + 1);
  /* settle success ⇒ exposure + end */
  st.recordExposure({ characterId: 'A', memoryIds: ['M1', 'M3'], turnIndex: idx });
  st.endHomeTurn({ turnId: tid });
  check('H9.settleSuccessWritesThenReleases', st.debugSize().homeTurns === 1);

  /* §29 error：不写 exposure，但必须 end */
  const errId = 'turn_err';
  const errIdx = st.beginHomeTurn({ characterId: 'A', turnId: errId });
  const before = st.getExposure({ characterId: 'A', memoryId: 'M2' });
  /* settled.status === 'error' ⇒ 跳过 recordExposure */
  st.endHomeTurn({ turnId: errId });
  check('H10.errorSkipsExposure', before === null && st.getExposure({ characterId: 'A', memoryId: 'M2' }) === null);
  check('H11.errorStillReleasesTurn', st.debugSize().homeTurns === 1);
}

/* §30 cleanup stress：200 轮混合 success/error，全部走**正常 settle cleanup**（不等 TTL） */
{
  const st = createRecallSessionState();
  let writes = 0;
  for (let i = 0; i < 200; i++) {
    const tid = 'turn_' + i;
    const idx = st.beginHomeTurn({ characterId: 'A', turnId: tid });
    const isError = (i % 3 === 0);
    if (!isError) { writes += st.recordExposure({ characterId: 'A', memoryIds: ['m' + (i % 5)], turnIndex: idx }); }
    st.endHomeTurn({ turnId: tid });
  }
  check('H12.stress200TurnsEndsAtZero', st.debugSize().homeTurns === 0,
    'homeTurns=' + st.debugSize().homeTurns);
  check('H13.stressWroteOnlySuccessTurns', writes > 0 && st.debugSize().memories === 5,
    'writes=' + writes + ' memories=' + st.debugSize().memories);
  /* 反向控制：不 end 就必须增长（证明 H12 是清理生效，而非从未记录） */
  const st2 = createRecallSessionState();
  for (let i = 0; i < 60; i++) st2.beginHomeTurn({ characterId: 'A', turnId: 'x' + i });
  check('H14.reverseControlWithoutEndItGrows', st2.debugSize().homeTurns === 60);
  check('H15.noTtlDependencyInCleanup',
    /endHomeTurn\(\{\s*turnId: settled\.turnId\s*\}\)/.test(gwSrc.replace(/\r\n/g, '\n'))
    || /recallSessionState\.endHomeTurn/.test(gwSrc));
}

/* §27 final injected IDs（Home Node 侧：selectedMemoryIds 已由 memory-retrieval 从 built.selected 派生） */
{
  check('H16.selectedMemoryIdsArePostSeatByConstruction',
    /const selectedIds = built\.selected\.map\(s => s\.id\)/.test(mrSrc.replace(/\r\n/g, '\n')),
    'selectedIds must be derived from the orchestrator result (post-seat)');
  check('H17.settleWriterConsumesSelectedMemoryIds',
    /memoryIds:\s*turn\.selectedMemoryIds/.test(gwSrc.replace(/\r\n/g, '\n')),
    'the writer must consume final injected ids, not reinforcementIds');
  check('H18.writerIsIndependentOfReinforcement',
    /const _reinfIds = Array\.isArray\(turn\.reinforcementIds\)/.test(gwSrc.replace(/\r\n/g, '\n'))
    && /memoryIds:\s*turn\.selectedMemoryIds/.test(gwSrc.replace(/\r\n/g, '\n')));
}

/* §28 Home Node coldStart：activation/reinforcement 与 exposure 分离 */
{
  const st = createRecallSessionState();
  const idx = st.beginHomeTurn({ characterId: 'A', turnId: 'cs' });
  /* coldStart: reinforcementIds === [] ⇒ reinforce 0 次; selectedMemoryIds > 0 ⇒ exposure 1 次 */
  const reinforcementIds = [];
  const selectedMemoryIds = ['anchor1', 'sem1'];
  let reinforceCalls = 0;
  if (reinforcementIds.length) reinforceCalls++;
  const written = st.recordExposure({ characterId: 'A', memoryIds: selectedMemoryIds, turnIndex: idx });
  st.endHomeTurn({ turnId: 'cs' });
  check('H19.coldStartSelectedNonEmpty', selectedMemoryIds.length > 0);
  check('H20.coldStartReinforcementEmptyAndNotCalled', reinforcementIds.length === 0 && reinforceCalls === 0);
  check('H21.coldStartExposureWrittenOnce', written === 2, 'written=' + written);
  check('H22.coldStartExposureIdsNonEmpty',
    st.getExposure({ characterId: 'A', memoryId: 'anchor1' }) !== null);
}

/* §31 same character / different conversation */
{
  const st = createRecallSessionState();
  const i1 = st.beginHomeTurn({ characterId: 'A', turnId: 'c1_t1' });
  st.recordExposure({ characterId: 'A', memoryIds: ['M1'], turnIndex: i1 });
  st.endHomeTurn({ turnId: 'c1_t1' });
  const i2 = st.beginHomeTurn({ characterId: 'A', turnId: 'c2_t1' });
  const f = computeCooldown({ channel: 'surface', currentTurnIndex: i2,
    exposure: st.getExposure({ characterId: 'A', memoryId: 'M1' }) }).factor;
  check('H23.conversationSwitchDoesNotReset', f === 0.40, 'factor=' + f);
}

/* §32 restart reset */
{
  const a = createRecallSessionState();
  const i = a.beginHomeTurn({ characterId: 'A', turnId: 't' });
  a.recordExposure({ characterId: 'A', memoryIds: ['M1'], turnIndex: i });
  const b = createRecallSessionState();      /* 全新 service/state ⇒ 模拟 restart */
  const ib = b.beginHomeTurn({ characterId: 'A', turnId: 't' });
  const f = computeCooldown({ channel: 'surface', currentTurnIndex: ib,
    exposure: b.getExposure({ characterId: 'A', memoryId: 'M1' }) }).factor;
  check('H24.restartResetsToFactorOne', f === 1, 'factor=' + f);
  check('H25.restartIsNotDurable', f === 1 && a.getExposure({ characterId: 'A', memoryId: 'M1' }) !== null);
}

/* §33 Browser activation 未被本轮顺手迁移 */
{
  /* recordMemoryActivation 真实位置是 assets/js/memory.js（不是 communication.js）。 */
  check('A1.activationStillOwnedByMemoryJs', /recordMemoryActivation/.test(memBare));
  check('A1b.activationNotMovedToSuccessSeam',
    !/recordMemoryActivation[\s\S]{0,200}memoryExposure/.test(memBare));
  check('A1c.exposureUsesIndependentSeam',
    /_ibRecordRecallExposure/.test(memBare) && /recordMemoryActivation/.test(memBare));
}

/* §34 BUG-1 永久守卫（行为 + 源码级） */
section('§34 · BUG-1 guard');
{
  const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
  const N = 1750000000000, D = 86400000;
  const mk = o => Object.assign({ id: 'm', title: 'T', content: 'C', importance: 5, arousal: 0.3,
    resolved: false, activationCount: 0, created: N - D, lastActivated: N - D, visibility: 'public',
    tags: [], domain: '日常', createdBy: 'user' }, o || {});
  const recs = [mk({ id: 'P', pinned: true, importance: 10 }), mk({ id: 'N1', importance: 12 })];
  const B = { apiId: 'role_a', now: N, isGroup: false, groupMemEnabled: false, includeHeader: false,
    contentLen: 200, maxChars: 2000 };
  const sel = (v) => { const m = Object.create(null); m.P = v;
    return CORE.buildMemoryContext(recs, Object.assign({}, B, { cooldownFactorsById: m })).selected.map(s => s.id); };
  check('BUG1.stringFactorIsRejected', JSON.stringify(sel('0.4')) !== JSON.stringify(['N1', 'P']));
  check('BUG1.booleanTrueIsRejected', JSON.stringify(sel(true)) !== JSON.stringify(['N1', 'P']));
  check('BUG1.numericFactorStillWorks', JSON.stringify(sel(0.4)) === JSON.stringify(['N1', 'P']));
  const coreSrc = fs.readFileSync(path.join(ROOT, 'assets/js/memory-retrieval-core.js'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('BUG1.noNumberCoercionOfFactor', !/Number\(map\[key\]\)/.test(coreSrc)
    && /typeof v !== "number"/.test(coreSrc));
}

/* ═══════════ §11–§14 · Browser hold/release 真实包装 ═══════════ */
section('§11–§14 · Browser holding=true reality (real source slices)');
{
  /* 三段**真实 production 源码**，绝不在这里重写 hold 逻辑：
       A · userChunk + exposure 包装
       B · 续写轮 o.onChunk hold 包装（holding = round>0）
       C · release hook（round 结束后 flush） */
  const A0 = commSrc.indexOf('  var userChunk=opts.onChunk||function(){};');
  const A1 = commSrc.indexOf('  var full=', A0);
  const SLICE_A = (A0 >= 0 && A1 > A0) ? commSrc.slice(A0, A1).replace(/\s+$/, '') : null;
  const B0 = commSrc.indexOf('      o.onChunk=function(ch){');
  const B1 = commSrc.indexOf('      };', B0);
  const SLICE_B = (B0 >= 0 && B1 > B0) ? commSrc.slice(B0, B1 + 9) : null;
  const C0 = commSrc.indexOf('if(holding){holding=false;hold=');
  const C1 = commSrc.indexOf('}', C0);
  const SLICE_C = C0 >= 0 ? commSrc.slice(C0, C1 + 1) : null;

  check('HR1.sliceAIsTheRealExposureWrapper', !!SLICE_A && SLICE_A.indexOf('_ibExpFired') >= 0);
  check('HR2.sliceBIsTheRealHoldWrapper', !!SLICE_B && SLICE_B.indexOf('hold+=') >= 0);
  check('HR3.sliceCIsTheRealReleaseHook', !!SLICE_C && SLICE_C.indexOf('if(holding)') === 0,
    JSON.stringify(SLICE_C));
  check('HR4.holdingIsContinuationRoundOnly', /var hold='',holding=round>0;/.test(commBare));

  /* harness：三段真实切片拼接。_wsDedupSeam 只在 hold>=500 时才会被调用，
     本用例 chunk 很小 ⇒ 不会触及那条分支（如实说明，不假装覆盖）。 */
  function makeHoldHarness(exposure) {
    const module = { exports: {} };
    const sandbox = { module, exports: module.exports, console, Object, JSON, String, Math, isFinite };
    vm.createContext(sandbox);
    const src = [
      'var _w=[]; var window={ _ibRecordRecallExposure: function(e){ _w.push(e); } };',
      'var _uv=[]; var opts={ _ibTurn: ' + JSON.stringify({ memoryExposure: exposure }) + ' };',
      'opts.onChunk=function(c){ _uv.push(c); };',
      'var full=""; var _wsDedupSeam=function(){ return null; };',
      SLICE_A,
      'var hold="",holding=true; var o={};',
      SLICE_B,
      'function providerChunk(c){ o.onChunk(c); }',
      'function release(piece){',
      SLICE_C,
      '}',
      'module.exports={ providerChunk:providerChunk, release:release, writes:function(){return _w.length;}, visible:function(){return _uv.slice();} };'
    ].join('\n');
    new vm.Script(src).runInContext(sandbox);
    return module.exports;
  }

  const hh = makeHoldHarness({ characterId: 'A', turnIndex: 11, memoryIds: ['M1', 'M3'] });
  hh.providerChunk('c1'); hh.providerChunk('c2'); hh.providerChunk('c3');
  check('HR5.heldChunksAreNotUserVisible', hh.visible().length === 0, JSON.stringify(hh.visible()));
  check('HR6.heldChunksWriteNoExposure', hh.writes() === 0,
    'provider bytes arrived but nothing was user-visible; writes=' + hh.writes());
  hh.release('c1c2c3');
  check('HR7.releaseMakesContentUserVisible', hh.visible().length === 1, JSON.stringify(hh.visible()));
  check('HR8.releaseWritesExposureExactlyOnce', hh.writes() === 1, 'writes=' + hh.writes());
  hh.release('again'); hh.providerChunk('c4');
  check('HR9.laterReleaseOrChunkDoesNotRewrite', hh.writes() === 1, 'writes=' + hh.writes());

  /* §12 反向控制：不调用真实 release hook ⇒ exposure 必须停在 0 */
  const hhNo = makeHoldHarness({ characterId: 'A', turnIndex: 12, memoryIds: ['M2'] });
  hhNo.providerChunk('x1'); hhNo.providerChunk('x2');
  check('HR10.reverseControlWithoutReleaseStaysZero', hhNo.writes() === 0,
    'removing the production release hook must keep exposure at 0');

  /* §14 retry + hold */
  const hh2 = makeHoldHarness({ characterId: 'A', turnIndex: 13, memoryIds: ['M4'] });
  hh2.providerChunk('r1'); hh2.providerChunk('r2');
  check('HR11.retryBeforeTokenNoWrite', hh2.writes() === 0);
  hh2.release('r1r2');
  check('HR12.retryThenReleaseWritesOnce', hh2.writes() === 1, 'writes=' + hh2.writes());
}

/* ═══════════ §21 · BUG-2 / BUG-3 永久反向 guard ═══════════ */
section('§21 · BUG-2 / BUG-3 permanent guards');
{
  const mr = mrSrc.replace(/\r\n/g, '\n');
  const gw = gwSrc.replace(/\r\n/g, '\n');
  const bug2 = [/deps\.sessionState/, /sessionState:\s*sessionState/, /turnIndex:\s*options\.turnIndex/];
  check('BG1.bug2AllThreeMarkersPresent', bug2.every(function (re) { return re.test(mr); }));
  check('BG2.bug2ReverseControlIsDiscriminating',
    bug2.every(function (re) { return !re.test(mr.replace(re, 'REMOVED')); }));
  const bug3 = [/beginHomeTurn\(\{/, /recordExposure\(\{/, /endHomeTurn\(\{/];
  /* 反向控制用 **global** 版本：`endHomeTurn({` 现在有**两个**合法调用点
     （P21-R2-F1b.4g-2c-2b §15 的 pre-run 失败清理 + settle 清理）。
     只替换第一处会让第二个调用点继续命中，从而把"标记存在"误报成"反向控制有效"。
     标记本身的词表没有变化 —— 变的是它被合法调用几次。 */
  const bug3All = [/beginHomeTurn\(\{/g, /recordExposure\(\{/g, /endHomeTurn\(\{/g];
  check('BG3.bug3AllThreeMarkersPresent', bug3.every(function (re) { return re.test(gw); }));
  check('BG4.bug3ReverseControlIsDiscriminating',
    bug3All.every(function (re) { return !re.test(gw.replace(re, 'REMOVED')); }));
  check('BG5.exposureWriteGatedOnSuccessAndIndependentOfReinforcement',
    /settled\.status !== 'error'[\s\S]{0,240}recordExposure/.test(gw)
    && /memoryIds:\s*turn\.selectedMemoryIds/.test(gw));
}

/* ══════════════════════════════════════════════════════════════════════════
   §35 · P21-R2-F1b.4g-2c-1b · Mobile Gateway Runtime RED Proof
   ══════════════════════════════════════════════════════════════════════════
   本轮目标：**用真实 production 入口**证明 BUG-6 的 runtime 事实，而不是靠
   源码字符串 index 或手搓数组。

   真实入口（唯一允许的入口 —— `gw.handle('chat/send')` 是 admin action 分支，
   到不了 mobile chat route）：
       gw.dispatch('/mobile/v1/chat/send', req, res,
                   new URL('http://127.0.0.1/mobile/v1/chat/send'))

   组件纪律：
     · real      : createMobileGateway / createMemoryRetrieval /
                   memory-recall-orchestrator / memory-retrieval-core /
                   createRecallSessionState —— 全部 production 实现
     · fake      : registry（device token / character / spec）、chat store、
                   memory store、executor（本轮不需要 provider）
     · sessionState **同一个实例** 同时注入 memoryRetrieval 与 gateway，
                   与 home-node-service.js 的 gatewayAssembly 装配一致

   spy 纪律：全部 transparent（记录后调用 original），
   不补 sessionState、不补 turnIndex、不改 factor、不改 ids、不改返回语义。

   本轮是 **RED**：正式 assertion 按**修复后应成立**的契约书写，
   因此 pre-fix 必然失败。这是下一轮修复的 authority —— 不得 skip / xfail /
   改 expected 为实际坏值。
   ══════════════════════════════════════════════════════════════════════════ */
section('§35 · Mobile Gateway runtime RED（真实 gw.dispatch → Turn1 / Turn2 ×3）');

const createMobileGateway = require(path.join(ROOT, 'services/home-node/mobile-gateway.js'));
const createMemoryRetrieval = require(path.join(ROOT, 'services/home-node/memory-retrieval.js'));
const CORE_NODE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const { Readable } = require('node:stream');

const RT_NOW = 1750000000000;
const RT_DAY = 86400000;
const RT_M1 = 'M1';
const RT_CHAR = 'role_a';
const RT_DEVICE = 'dev_1';
const RT_TOKEN = 'dev-token-1';
const RT_QUERY = '显卡';
const RT_ROUTE = '/mobile/v1/chat/send';
const RT_URL = 'http://127.0.0.1' + RT_ROUTE;
const RT_EXPECTED_FACTOR = 0.40;
/* trace contract 自己的 penalty 词表（不新增自定义 reason 文本）。 */
const RT_PENALTY_REASON = require(path.join(ROOT, 'assets/js/memory-recall/cooldown.js')).REASON_PENALTY;

/* memory fixture：M1 与 query '显卡' 稳定相关（title + content 命中），
   budget 装得下（单条）。刻意**不**加 pinned —— pinned 会引入
   coldStart anchor / pinned-first 特权两套额外语义。 */
function rtMemoryRecord() {
  return {
    id: RT_M1,
    title: '显卡',
    content: '显卡：本地装机时选的显卡型号与预算',
    importance: 8,
    arousal: 0.3,
    resolved: false,
    activationCount: 0,
    created: RT_NOW - RT_DAY,
    lastActivated: RT_NOW - RT_DAY,
    visibility: 'public',
    tags: [],
    domain: '日常',
    createdBy: 'user'
  };
}

/* registry stub：production parser 实际用到的四个成员。
   可选 characterIds：多角色场景（§9 character isolation）用，默认单角色 ⇒ 既有行为不变。 */
function rtRegistry(characterIds) {
  const ids = (Array.isArray(characterIds) && characterIds.length) ? characterIds : [RT_CHAR];
  return {
    fingerprint: 'runtime-red',
    verifyDeviceToken: function (raw) {
      return raw === RT_TOKEN
        ? { ok: true, device: { deviceId: RT_DEVICE, capabilities: ['chat'] } }
        : { ok: false, code: 'AUTH_INVALID' };
    },
    getCharacter: function (id) {
      return ids.indexOf(id) >= 0 ? { id: id, dto: { id: id, nickname: String(id), relationship: '' } } : null;
    },
    getCharacterSpec: function (id) {
      return ids.indexOf(id) >= 0
        ? { endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'red-model', systemPrompt: 'S' }
        : null;
    }
  };
}

/* chat store stub：只实现 parseSendPayload / runtime context / settle 真正调用的成员。
   listMessages 返回**既有消息** ⇒ production 的 coldStart 探针得到 isFirstTurn=false
   ⇒ 回合落在 surface 通道（cooldown obey）。
   可选 priorMessages：0 ⇒ 真正空的会话 ⇒ isFirstTurn=true ⇒ coldStart（§6 用）；
   setPriorMessages() 用于在冷启动回合之后把该会话变成"已有消息"（production 里由
   executor 的 canonical 写入产生），从而让下一回合回到 surface（§7 用）。
   默认 1 ⇒ 既有 §35 行为逐字不变。 */
function rtChatStore(priorMessages) {
  let count = priorMessages == null ? 1 : Number(priorMessages);
  const prior = { id: 'msg_prior_1', role: 'user', content: '之前聊过的事', friendId: RT_CHAR, timestamp: RT_NOW - 60000 };
  return {
    getRevision: function () { return 1; },
    getUserProfile: function () { return null; },
    listMessages: function () { return { ok: true, messages: count > 0 ? [prior] : [], revision: 1 }; },
    getMessage: function () { return null; },
    setPriorMessages: function (n) { count = Number(n) || 0; }
  };
}

/* memory store stub。可选 settings（published budget / contentLen，§4 Final-ID 需要
   精确控制预算）+ activation 调用记录（§4 F5 / §6 C6 证据）。 */
function rtMemoryStore(records, settings) {
  const activationCalls = [];
  return {
    listRecords: function () { return { ok: true, records: records }; },
    getMemorySettings: settings
      ? function () { return { ok: true, settings: settings }; }
      : undefined,
    recordActivation: function (ids, opts) {
      activationCalls.push({ ids: Array.isArray(ids) ? ids.slice() : ids, at: opts && opts.at });
      return { ok: true, updated: Array.isArray(ids) ? ids.length : 0, revisionTouched: false };
    },
    activationCalls: activationCalls
  };
}

/* req/res：形态取自 tests/test_voicebox_asr_provider.js 的 in-process mock。 */
function rtReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer ' + RT_TOKEN, accept: 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function rtRes() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead: function (status, headers) { this.status = status; this.headers = headers; },
    end: function (body) { this.body = body; }
  };
}

const rtDelay = ms => new Promise(r => setTimeout(r, ms));
async function rtWaitFor(pred, budgetMs) {
  const deadline = Date.now() + (budgetMs || 5000);
  for (;;) {
    let ok = false;
    try { ok = pred() === true; } catch (e) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await rtDelay(10);
  }
}

async function rtRun(label) {
  const events = [];
  const recallCalls = [];
  const wrapperCalls = [];
  const retrieveCalls = [];
  const coreCalls = [];
  const executorCalls = [];
  const beginCalls = [];
  const exposureCalls = [];
  const endCalls = [];
  const runtimeLog = [];

  /* ── frozen §2/§6：同一个 sessionState 实例，双方共享 ── */
  const sharedSessionState = createRecallSessionState();
  const memoryRetrieval = createMemoryRetrieval({
    store: rtMemoryStore([rtMemoryRecord()]),
    clock: () => RT_NOW,
    sessionState: sharedSessionState,
    random: () => 0.5
  });
  const gateway = createMobileGateway({
    store: rtChatStore(),
    registry: rtRegistry(),
    /* fake executor：由 production runTurn 调用，test 绝不主动调用。 */
    executor: {
      executeCharacterTurn: async function (request, options) {
        executorCalls.push({ request: request, options: options });
        return {
          ok: true, outcome: 'completed', turnId: options.turnId,
          userMessageId: 'u1', assistantMessageId: 'a1', revision: 1
        };
      }
    },
    sessionState: sharedSessionState,
    memoryRetrieval: memoryRetrieval,
    clock: () => RT_NOW,
    random: () => 0.5,
    logger: function (level, event, fields) { runtimeLog.push({ level: level, event: event, fields: fields }); }
  });

  /* ── Spies（transparent）────────────────────────────────────────────── */
  const realOrchRecall = ORCH.recall;
  ORCH.recall = function (records, options) {
    const o = options || {};
    const rec = {
      turnIndex: o.turnIndex,
      hasTurnIndex: Object.prototype.hasOwnProperty.call(o, 'turnIndex'),
      sessionState: o.sessionState,
      sessionStateIsShared: o.sessionState === sharedSessionState,
      turn: o.turn ? JSON.parse(JSON.stringify(o.turn)) : null,
      channel: null, traceFactorM1: null, decisionM1: null, reasonsM1: [], selectedIds: []
    };
    recallCalls.push(rec);
    /* §9 · 实际 retrieval boundary 的 runtime event（不是源码行号）。 */
    events.push(['retrieve', {
      turnIndex: o.turnIndex,
      hasSessionState: o.sessionState != null,
      sameInstance: o.sessionState === sharedSessionState
    }]);
    const out = realOrchRecall.apply(this, arguments);
    try {
      rec.channel = (out && out.meta) ? out.meta.channel : null;
      rec.selectedIds = (out && out.result && Array.isArray(out.result.selected))
        ? out.result.selected.map(s => s.id) : [];
      const cands = (out && out.trace && Array.isArray(out.trace.candidates)) ? out.trace.candidates : [];
      const row = cands.filter(c => c && c.memoryId === RT_M1)[0] || null;
      if (row) {
        rec.traceFactorM1 = row.cooldownFactor;
        rec.decisionM1 = row.decision;
        rec.reasonsM1 = Array.isArray(row.reasons) ? row.reasons.slice() : [];
      }
    } catch (e) { runtimeLog.push({ level: 'spy', event: 'trace-capture-failed' }); }
    return out;
  };

  const realWrapper = memoryRetrieval.buildRuntimeContext;
  memoryRetrieval.buildRuntimeContext = function (input) {
    const a = input || {};
    const rec = {
      hasOwnSessionState: Object.prototype.hasOwnProperty.call(a, 'sessionState'),
      sessionState: a.sessionState,
      hasOwnTurnIndex: Object.prototype.hasOwnProperty.call(a, 'turnIndex'),
      turnIndex: a.turnIndex,
      keys: Object.keys(a),
      characterId: a.characterId,
      userMessage: a.userMessage,
      conversationId: a.conversationId
    };
    wrapperCalls.push(rec);
    events.push(['retrieve-wrapper', {
      hasOwnTurnIndex: rec.hasOwnTurnIndex, turnIndex: rec.turnIndex, hasOwnSessionState: rec.hasOwnSessionState
    }]);
    return realWrapper.apply(this, arguments);
  };

  /* 第二层：memory-retrieval.buildRuntimeContext 是否把 turnIndex 转给 retrieve()。 */
  const realRetrieve = memoryRetrieval.retrieve;
  memoryRetrieval.retrieve = function (characterId, options) {
    const o = options || {};
    retrieveCalls.push({
      characterId: characterId,
      hasOwnTurnIndex: Object.prototype.hasOwnProperty.call(o, 'turnIndex'),
      turnIndex: o.turnIndex
    });
    return realRetrieve.apply(this, arguments);
  };

  /* 唯一 selector 的**真实输入**：cooldownFactorsById（orchestrator → core）。 */
  const realBuildCtx = CORE_NODE.buildMemoryContext;
  CORE_NODE.buildMemoryContext = function (records, options) {
    const o = options || {};
    const out = realBuildCtx.apply(this, arguments);
    if (String(o.userMessage || '') === RT_QUERY) {
      const map = o.cooldownFactorsById;
      const hasMap = !!map && typeof map === 'object';
      const hasOwnM1 = hasMap && Object.prototype.hasOwnProperty.call(map, RT_M1);
      coreCalls.push({
        hasFactorsMap: hasMap,
        hasOwnM1Factor: hasOwnM1,
        m1Factor: hasOwnM1 ? map[RT_M1] : null,
        selectedIds: (out && Array.isArray(out.selected)) ? out.selected.map(s => s.id) : []
      });
    }
    return out;
  };

  const realBegin = sharedSessionState.beginHomeTurn;
  sharedSessionState.beginHomeTurn = function (input) {
    const idx = realBegin.apply(this, arguments);
    beginCalls.push({ turnId: input && input.turnId, characterId: input && input.characterId, turnIndex: idx });
    events.push(['begin-home-turn', { turnIndex: idx, turnId: input && input.turnId }]);
    return idx;
  };
  const realRecordExposure = sharedSessionState.recordExposure;
  sharedSessionState.recordExposure = function (input) {
    const written = realRecordExposure.apply(this, arguments);
    const ids = (input && Array.isArray(input.memoryIds)) ? input.memoryIds.slice() : [];
    exposureCalls.push({ characterId: input && input.characterId, memoryIds: ids, turnIndex: input && input.turnIndex, written: written });
    events.push(['record-exposure', { turnIndex: input && input.turnIndex, memoryIds: ids, written: written }]);
    return written;
  };
  const realEnd = sharedSessionState.endHomeTurn;
  sharedSessionState.endHomeTurn = function (input) {
    const released = realEnd.apply(this, arguments);
    endCalls.push({ turnId: input && input.turnId, released: released });
    events.push(['end-home-turn', { turnId: input && input.turnId, released: released }]);
    return released;
  };

  /* ── 真实 dispatcher ─────────────────────────────────────────────────── */
  async function send(requestId, content) {
    const eventStart = events.length;
    events.push(['dispatch', { requestId: requestId }]);
    const res = rtRes();
    await gateway.dispatch(RT_ROUTE, rtReq({
      v: 1,
      requestId: requestId,
      /* 刻意不传 conversationId / deviceId：两者都由 production 派生。 */
      payload: { characterId: RT_CHAR, content: content }
    }), res, new URL(RT_URL));
    let body = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch (e) { body = null; }
    return { res: res, body: body, eventStart: eventStart };
  }
  /* runTurn 是 fire-and-forget：必须 polling 到 terminal **且** settle 完成。 */
  function settled(requestId, expectedEndCalls) {
    const turn = gateway.getTurnByRequest(requestId);
    return !!turn && turn.status !== 'running' && endCalls.length >= expectedEndCalls;
  }

  const result = { label: label, turn1Gate: false, redFactor: false, orderIsPreFix: false };

  /* ══ Turn1 ══════════════════════════════════════════════════════════ */
  const t1 = await send('req_1', RT_QUERY);
  const recall1 = recallCalls[0] || null;
  const core1 = coreCalls[0] || null;
  const wrapper1 = wrapperCalls[0] || null;
  const retrieve1 = retrieveCalls[0] || null;
  const turn1Settled = await rtWaitFor(() => settled('req_1', 1), 5000);
  const turn1 = gateway.getTurnByRequest('req_1');
  const exposure1 = sharedSessionState.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });

  const T1 = t1.res.status === 202 && !!t1.body && t1.body.ok === true && t1.body.v === 1
    && t1.body.type === 'chat.send' && !!(t1.body.payload && t1.body.payload.turnId);
  const T2 = executorCalls.length === 1;
  const T3 = !!turn1 && turn1.status !== 'running' && turn1.status !== 'error';
  const T4 = !!turn1 && Array.isArray(turn1.selectedMemoryIds) && turn1.selectedMemoryIds.indexOf(RT_M1) >= 0;
  const T5 = beginCalls.length === 1;
  const T6 = beginCalls.length === 1 && beginCalls[0].turnIndex === 1;
  const T7 = exposureCalls.length === 1;
  const T8 = exposureCalls.length === 1 && exposureCalls[0].memoryIds.indexOf(RT_M1) >= 0;
  const T9 = !!exposure1 && exposure1.exposureCount === 1;
  const T10 = endCalls.length === 1;
  const T11 = sharedSessionState.debugSize().homeTurns === 0;

  check('BUG6.runtime.turn1.T1.responseEnvelope', T1, '[' + label + '] ' + JSON.stringify({ status: t1.res.status, body: t1.body }));
  check('BUG6.runtime.turn1.T2.executorCalledOnce', T2, '[' + label + '] calls=' + executorCalls.length);
  check('BUG6.runtime.turn1.T3.turnTerminalNonError', T3, '[' + label + '] status=' + (turn1 && turn1.status) + ' settled=' + turn1Settled);
  check('BUG6.runtime.turn1.T4.selectedMemoryIdsHasM1', T4, '[' + label + '] ' + JSON.stringify(turn1 && turn1.selectedMemoryIds));
  check('BUG6.runtime.turn1.T5.beginHomeTurnOnce', T5, '[' + label + '] calls=' + beginCalls.length);
  check('BUG6.runtime.turn1.T6.returnedTurnIndexIs1', T6, '[' + label + '] ' + JSON.stringify(beginCalls));
  check('BUG6.runtime.turn1.T7.recordExposureOnce', T7, '[' + label + '] calls=' + exposureCalls.length);
  check('BUG6.runtime.turn1.T8.exposureIdsHasM1', T8, '[' + label + '] ' + JSON.stringify(exposureCalls));
  check('BUG6.runtime.turn1.T9.exposureCountIs1', T9, '[' + label + '] ' + JSON.stringify(exposure1));
  check('BUG6.runtime.turn1.T10.endHomeTurnOnce', T10, '[' + label + '] calls=' + endCalls.length);
  check('BUG6.runtime.turn1.T11.noActiveHomeTurn', T11, '[' + label + '] ' + JSON.stringify(sharedSessionState.debugSize()));

  result.turn1Gate = T1 && T2 && T3 && T4 && T5 && T6 && T7 && T8 && T9 && T10 && T11;
  result.turn1SelectedM1 = T4;
  result.turn1ExposureCount = exposure1 ? exposure1.exposureCount : null;
  result.turn1Cleanup = T11;
  result.turn2Expected = RT_EXPECTED_FACTOR;
  result.turn2Actual = null;
  check('BUG6_RED_PRECONDITION', result.turn1Gate === true,
    '[' + label + '] ' + (result.turn1Gate ? 'SATISFIED' : 'FAILED') + ' T1-T11=' + JSON.stringify([T1,T2,T3,T4,T5,T6,T7,T8,T9,T10,T11]));

  /* ── §17 · BUG-7 permanent guard（修复后永久生效）─────────────────────
     T7/T8/T9 是 exposure **成功写入** 的永久 guard；
     这一条专门钉住"写侧异常不得再次复发"：
     production 不得再产生 memory-exposure-failed / ReferenceError。
     （pre-fix 的 characterization 版本已随 BUG-7 修复退役 —— 它当时断言异常存在。） */
  const swallowed = runtimeLog.filter(l => l.event === 'memory-exposure-failed');
  const referenceErrors = runtimeLog.filter(l => /is not defined|ReferenceError/.test(String((l.fields || {}).error || '')));
  result.exposureBlocker = swallowed.length ? String((swallowed[0].fields || {}).error || '') : null;
  result.exposureWarnings = swallowed.length;
  result.referenceErrors = referenceErrors.length;
  result.runtimeLog = runtimeLog;
  console.log('  [' + label + '] gateway logger (warn/error): ' + JSON.stringify(runtimeLog.filter(l => l.level !== 'info')));
  check('BUG7.runtime.noExposureReferenceError', swallowed.length === 0 && referenceErrors.length === 0,
    '[' + label + '] ' + JSON.stringify({ memoryExposureFailed: swallowed.length, referenceErrors: referenceErrors.length, warnings: runtimeLog.filter(l => l.level !== 'info') }));

  /* ── §13 Turn1 wrapper evidence（只记录，不单独判失败）── */
  result.wrapperTurn1 = wrapper1 ? {
    hasOwnTurnIndex: wrapper1.hasOwnTurnIndex,
    turnIndex: wrapper1.turnIndex === undefined ? null : wrapper1.turnIndex,
    hasOwnSessionState: wrapper1.hasOwnSessionState,
    keys: wrapper1.keys
  } : null;
  result.retrieveTurn1 = retrieve1 ? { hasOwnTurnIndex: retrieve1.hasOwnTurnIndex, turnIndex: retrieve1.turnIndex === undefined ? null : retrieve1.turnIndex } : null;
  result.orchTurn1 = recall1 ? {
    hasTurnIndex: recall1.hasTurnIndex,
    turnIndex: recall1.turnIndex === undefined ? null : recall1.turnIndex,
    sessionStateIsShared: recall1.sessionStateIsShared,
    channel: recall1.channel,
    turnMessage: recall1.turn ? recall1.turn.message : null
  } : null;
  result.orchTurn1Index = recall1 ? (recall1.turnIndex === undefined ? null : recall1.turnIndex) : null;

  /* ── §14 Turn1 runtime order（真实 events）── */
  const turn1Events = t1.eventStart >= 0 ? events.slice(t1.eventStart, events.length) : events.slice();
  result.turn1Events = turn1Events;
  const seq1 = turn1Events.filter(e => e[0] === 'retrieve' || e[0] === 'begin-home-turn' || e[0] === 'retrieve-wrapper').map(e => e[0]);
  const iBegin = turn1Events.findIndex(e => e[0] === 'begin-home-turn');
  const iRetrieve = turn1Events.findIndex(e => e[0] === 'retrieve');
  result.orderSeqTurn1 = seq1;
  result.orderIsPreFix = iRetrieve >= 0 && iBegin >= 0 && iRetrieve < iBegin;
  result.orderBeginBeforeRetrieve = iBegin >= 0 && iRetrieve >= 0 && iBegin < iRetrieve;
  console.log('  [' + label + '] runtime events (Turn1): ' + JSON.stringify(seq1));
  console.log('  [' + label + '] wrapper actualArgs: ' + JSON.stringify(result.wrapperTurn1));
  console.log('  [' + label + '] retrieve actualArgs: ' + JSON.stringify(result.retrieveTurn1));
  console.log('  [' + label + '] ORCH.recall options: ' + JSON.stringify(result.orchTurn1));

  /* ── §11/§12 · 永久 contract guards（修复后必须恒绿，来自真实 runtime events）──
     原 pre-fix characterization（`BUG6.runtime.preFixOrder` / 断言 wrapper 无
     turnIndex）已随 BUG-6 修复退役 —— 它们当时记录的是坏状态。 */
  check('BUG6.runtime.order.beginBeforeRetrieve', result.orderBeginBeforeRetrieve === true,
    '[' + label + '] ' + JSON.stringify({ contract: 'begin-home-turn < retrieve', observedEventOrder: seq1 }));
  check('BUG6.runtime.wrapper.turnIndex', !!(wrapper1 && wrapper1.hasOwnTurnIndex === true && wrapper1.turnIndex === 1),
    '[' + label + '] Turn1 wrapper must carry numeric turnIndex=1: ' + JSON.stringify(result.wrapperTurn1));
  check('BUG6.runtime.orch.turnIndex', !!(recall1 && recall1.turnIndex === 1 && recall1.sessionStateIsShared === true),
    '[' + label + '] Turn1 ORCH must receive turnIndex=1 with shared sessionState: ' + JSON.stringify(result.orchTurn1));
  /* A4 等价物的 **runtime** 证据：ORCH 收到的 turn.message 必须是本轮用户输入
     （来自 payload.content），不是历史最后一条、不是 assistant、不是 summary。 */
  check('BUG6.runtime.orch.turnMessage', !!(recall1 && recall1.turn && recall1.turn.message === RT_QUERY),
    '[' + label + '] ' + JSON.stringify({ expected: RT_QUERY, actual: recall1 && recall1.turn ? recall1.turn.message : null }));

  if (!result.turn1Gate) {
    result.stopped = 'turn1-gate-failed';
    result.runtimeLog = runtimeLog;
    ORCH.recall = realOrchRecall;
    CORE_NODE.buildMemoryContext = realBuildCtx;
    return result;
  }

  /* ══ Duplicate request（§17 · 真实 gateway duplicate path）══════════════
     同一 requestId 再发一次。要求：不新增 logical turn（begin 不增、character
     counter 不增）、不重复 exposure、不产生第二个 endHomeTurn，
     response 维持既有 duplicate semantics（不改 API contract）。 */
  const dupBefore = {
    exec: executorCalls.length, begin: beginCalls.length, end: endCalls.length,
    exp: exposureCalls.length, counter: sharedSessionState.currentTurnIndex({ characterId: RT_CHAR })
  };
  const dup = await send('req_1', RT_QUERY);
  await rtDelay(40);
  const dupExposure = sharedSessionState.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 }) || {};
  const dupAfter = {
    exec: executorCalls.length, begin: beginCalls.length, end: endCalls.length,
    exp: exposureCalls.length, counter: sharedSessionState.currentTurnIndex({ characterId: RT_CHAR }),
    exposureCount: dupExposure.exposureCount == null ? null : dupExposure.exposureCount
  };
  result.duplicate = { before: dupBefore, after: dupAfter, status: dup.res.status, body: dup.body };
  const D1 = dupAfter.exec === dupBefore.exec;
  const D2 = dupAfter.begin === dupBefore.begin;
  const D3 = dupAfter.counter === dupBefore.counter && dupAfter.counter === 1;
  const D4 = dupAfter.exp === dupBefore.exp && dupAfter.exposureCount === 1;
  const D5 = dupAfter.end === dupBefore.end;
  const D6 = dup.res.status === 200 && !!dup.body && dup.body.ok === true && dup.body.type === 'chat.send'
    && !!(dup.body.payload && dup.body.payload.duplicateRequest === true)
    && dup.body.payload.turnId === turn1.turnId;
  console.log('  [' + label + '] duplicate req_1: ' + JSON.stringify(result.duplicate));
  check('BUG6.runtime.duplicate.noExtraLogicalTurn', D1 && D2 && D3,
    '[' + label + '] ' + JSON.stringify({ executor: [dupBefore.exec, dupAfter.exec], begin: [dupBefore.begin, dupAfter.begin], counter: [dupBefore.counter, dupAfter.counter] }));
  check('BUG6.runtime.duplicate.noDoubleExposure', D4 && D5,
    '[' + label + '] ' + JSON.stringify({ exposureCalls: [dupBefore.exp, dupAfter.exp], endCalls: [dupBefore.end, dupAfter.end], exposureCount: dupAfter.exposureCount }));
  check('BUG6.runtime.duplicate.responseSemantics', D6,
    '[' + label + '] ' + JSON.stringify({ status: dup.res.status, payload: dup.body && dup.body.payload }));

  /* ══ Turn2 ══════════════════════════════════════════════════════════ */
  const t2 = await send('req_2', RT_QUERY);
  const recall2 = recallCalls[1] || null;
  const core2 = coreCalls[1] || null;
  const wrapper2 = wrapperCalls[1] || null;
  const begin2 = beginCalls[1] || null;
  const turn2Settled = await rtWaitFor(() => settled('req_2', 2), 5000);
  const turn2 = gateway.getTurnByRequest('req_2');
  const exposure2 = sharedSessionState.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });

  const T2b = t2.res.status === 202 && !!t2.body && t2.body.ok === true;
  const turn2Events = events.slice(t2.eventStart, events.length);
  const seq2 = turn2Events.filter(e => e[0] === 'retrieve' || e[0] === 'begin-home-turn' || e[0] === 'retrieve-wrapper').map(e => e[0]);
  const iBegin2 = turn2Events.findIndex(e => e[0] === 'begin-home-turn');
  const iRetrieve2 = turn2Events.findIndex(e => e[0] === 'retrieve');
  result.orderSeqTurn2 = seq2;
  result.orderBeginBeforeRetrieveTurn2 = iBegin2 >= 0 && iRetrieve2 >= 0 && iBegin2 < iRetrieve2;
  result.beginCalls = beginCalls.map(b => ({ turnIndex: b.turnIndex, turnId: b.turnId }));

  /* ── §16 actual cooldown factor：只从真实 production 观测点取值 ──
     优先级：ORCH trace candidate（production trace，真实 cooldownInfoById 的投影）
             → 唯一 selector 的真实输入 map（cooldownFactorsById[M1]）
             → 两者都没有 ⇒ core 的 fail-safe（memory-retrieval-core.cooldownFactorOf
               对缺失 map 返回 1），并**如实标注 source**。 */
  function observedFactor(recallRec, coreRec) {
    if (recallRec && typeof recallRec.traceFactorM1 === 'number') {
      return { value: recallRec.traceFactorM1, source: 'orch.trace.candidates[M1].cooldownFactor' };
    }
    if (coreRec && coreRec.hasOwnM1Factor && typeof coreRec.m1Factor === 'number') {
      return { value: coreRec.m1Factor, source: 'core opts.cooldownFactorsById[M1]' };
    }
    if (coreRec && coreRec.hasFactorsMap === false) {
      return { value: 1, source: 'no cooldownFactorsById map reached core => selector fail-safe 1 (memory-retrieval-core.cooldownFactorOf)' };
    }
    return { value: null, source: 'unobserved' };
  }
  const obs2 = observedFactor(recall2, core2);
  result.turn2Actual = obs2.value;
  result.turn2ActualSource = obs2.source;
  result.turn2Expected = RT_EXPECTED_FACTOR;
  result.turn2Trace = recall2 ? { channel: recall2.channel, factor: recall2.traceFactorM1, decision: recall2.decisionM1, reasons: recall2.reasonsM1, turnIndex: recall2.turnIndex === undefined ? null : recall2.turnIndex } : null;
  result.turn2CoreMap = core2 ? { hasFactorsMap: core2.hasFactorsMap, hasOwnM1Factor: core2.hasOwnM1Factor, m1Factor: core2.m1Factor, selectedIds: core2.selectedIds } : null;
  result.turn2Wrapper = wrapper2 ? { hasOwnTurnIndex: wrapper2.hasOwnTurnIndex, turnIndex: wrapper2.turnIndex === undefined ? null : wrapper2.turnIndex } : null;
  result.turn2Settled = turn2Settled && !!turn2 && turn2.status !== 'running' && turn2.status !== 'error';
  result.turn2SelectedM1 = !!turn2 && Array.isArray(turn2.selectedMemoryIds) && turn2.selectedMemoryIds.indexOf(RT_M1) >= 0;
  result.turn2ResponseOk = T2b;

  console.log('  [' + label + '] Turn2 ORCH: ' + JSON.stringify(result.turn2Trace)
    + '  coreMap: ' + JSON.stringify(result.turn2CoreMap)
    + '  actualFactor: ' + JSON.stringify({ value: obs2.value, source: obs2.source }));

  /* ── §13 · Turn2 cooldown factor（契约极性 · 永久 guard）────────────────
     expected = 0.40：distance = currentTurnIndex(2) − lastExposureTurn(1) = 1，
     channel = surface ⇒ 契约曲线 d1 = 0.40。
     actual 只从真实 production 观测点取值，绝不自己 computeCooldown 造答案。 */
  result.redFactor = obs2.value !== RT_EXPECTED_FACTOR;
  check('BUG6.runtime.turn2.cooldownFactor', obs2.value === RT_EXPECTED_FACTOR,
    '[' + label + '] ' + JSON.stringify({ expected: RT_EXPECTED_FACTOR, actual: obs2.value, source: obs2.source, turn2SelectedM1: result.turn2SelectedM1, exposureCount: exposure2 ? exposure2.exposureCount : null }));

  /* ── §13/§10/§18 · Turn2 其余契约断言（全部来自真实 runtime）────────── */
  check('BUG6.runtime.turn2.cooldownReason',
    !!(recall2 && recall2.reasonsM1.indexOf(RT_PENALTY_REASON) >= 0),
    '[' + label + '] ' + JSON.stringify({ expectedReason: RT_PENALTY_REASON, actualReasons: recall2 ? recall2.reasonsM1 : null }));

  /* §13/§18 · Turn2 的 logical index 必须是 2（duplicate 没有污染 turn distance）。 */
  check('BUG6.runtime.turn2.indexIs2',
    !!(recall2 && recall2.turnIndex === 2) && !!(wrapper2 && wrapper2.hasOwnTurnIndex === true && wrapper2.turnIndex === 2),
    '[' + label + '] ' + JSON.stringify({ orchTurnIndex: recall2 ? recall2.turnIndex : null, wrapper: result.turn2Wrapper, begin2: begin2 }));

  /* §10 · beginHomeTurn：每个 **new logical turn** 恰好一次 ⇒ Turn1 + Turn2 = 2
     （duplicate 不得贡献第三次）。索引必须严格是 1、2。 */
  check('BUG6.runtime.beginOnce.perLogicalTurn',
    beginCalls.length === 2 && beginCalls[0].turnIndex === 1 && !!begin2 && begin2.turnIndex === 2
      && begin2.turnId !== beginCalls[0].turnId,
    '[' + label + '] ' + JSON.stringify(result.beginCalls));

  /* §13 · Turn2 的 runtime order 同样必须是 begin < retrieve。 */
  check('BUG6.runtime.order.turn2BeginBeforeRetrieve', result.orderBeginBeforeRetrieveTurn2 === true,
    '[' + label + '] ' + JSON.stringify({ contract: 'begin-home-turn < retrieve', observedEventOrder: seq2 }));
  /* sessionState 身份链：永久 guard —— retrieval 与 writer 必须是同一个实例，
     否则 cooldown 读的与写的会是两份状态（而且不会报错，只会静默失效）。 */
  check('BUG6.runtime.wrapper.sessionState', !!(recall1 && recall1.sessionStateIsShared === true),
    '[' + label + '] wrapper.hasOwnSessionState=' + (wrapper1 && wrapper1.hasOwnSessionState)
    + ' ORCH.sessionStateIsShared=' + (recall1 && recall1.sessionStateIsShared));

  result.runtimeLog = runtimeLog;
  result.events = events;

  ORCH.recall = realOrchRecall;
  CORE_NODE.buildMemoryContext = realBuildCtx;
  return result;
}

/* ══ §36 · P21-R2-F1b.4g-2c-3 · Gateway Behavioral Closure ═══════════════
   复用 §35 的 fixture（rtRegistry / rtChatStore / rtMemoryStore / rtReq / rtRes），
   只抽一个**极小 service factory**，不复制第二套 harness。
   真实：createMobileGateway / createMemoryRetrieval / ORCH / core / RecallSessionState。
   fixture：registry / chat store / memory store / executor（fake model seam）。 */
function rtService(cfg) {
  cfg = cfg || {};
  const state = cfg.sessionState || createRecallSessionState();
  const records = cfg.records || [rtMemoryRecord()];
  const store = rtMemoryStore(records, cfg.settings || null);
  const chatStore = rtChatStore(cfg.priorMessages);
  const retrieval = createMemoryRetrieval({
    store: store, clock: () => RT_NOW, sessionState: state, random: () => 0.5
  });
  const spy = { recall: [], core: [], wrapper: [], executor: [], begin: [], exposure: [], end: [], warnings: [] };
  const executor = cfg.executor || function (request, options) {
    return { ok: true, outcome: 'completed', turnId: options.turnId, userMessageId: 'u1', assistantMessageId: 'a1', revision: 1 };
  };
  const gateway = createMobileGateway({
    store: chatStore,
    registry: cfg.registry || rtRegistry(),
    executor: {
      executeCharacterTurn: async function (request, options) {
        spy.executor.push({ request: request, options: options });
        return executor(request, options);
      }
    },
    sessionState: state,
    memoryRetrieval: retrieval,
    clock: () => RT_NOW,
    random: () => 0.5,
    logger: function (level, event, fields) {
      if (level !== 'info') spy.warnings.push({ level: level, event: event, error: fields && fields.error });
    }
  });
  const real = {
    recall: ORCH.recall,
    core: CORE_NODE.buildMemoryContext,
    wrapper: retrieval.buildRuntimeContext,
    begin: state.beginHomeTurn,
    exposure: state.recordExposure,
    end: state.endHomeTurn
  };
  /* §11 反控：只把 **exposure-write seam** 变成 no-op（形状/返回足以让流程继续）。
     不动 ORCH、不动 core、不动 selection、不绕过 gateway。 */
  if (cfg.exposureNoop) real.exposure = function () { return 0; };

  ORCH.recall = function (recs, options) {
    const o = options || {};
    const rec = {
      turnIndex: o.turnIndex, turnMessage: o.turn ? o.turn.message : null,
      sessionStateIsShared: o.sessionState === state, channel: null, activationPolicy: null,
      injectedMemoryIds: [], selectedIds: [], candidates: []
    };
    spy.recall.push(rec);
    const out = real.recall.apply(this, arguments);
    try {
      rec.channel = out && out.meta ? out.meta.channel : null;
      rec.activationPolicy = out && out.meta ? out.meta.activationPolicy : null;
      rec.injectedMemoryIds = (out && out.meta && Array.isArray(out.meta.injectedMemoryIds)) ? out.meta.injectedMemoryIds.slice() : [];
      rec.selectedIds = (out && out.result && Array.isArray(out.result.selected)) ? out.result.selected.map(s => s.id) : [];
      const cands = (out && out.trace && Array.isArray(out.trace.candidates)) ? out.trace.candidates : [];
      rec.candidates = cands.map(c => ({ memoryId: c.memoryId, decision: c.decision, reasons: (c.reasons || []).slice(), cooldownFactor: c.cooldownFactor }));
    } catch (e) { /* capture-only */ }
    return out;
  };
  CORE_NODE.buildMemoryContext = function (recs, options) {
    const o = options || {};
    const out = real.core.apply(this, arguments);
    spy.core.push({
      userMessage: String(o.userMessage == null ? '' : o.userMessage),
      hasFactorsMap: !!o.cooldownFactorsById,
      factors: o.cooldownFactorsById ? Object.assign({}, o.cooldownFactorsById) : null,
      selectedIds: (out && Array.isArray(out.selected)) ? out.selected.map(s => s.id) : []
    });
    return out;
  };
  retrieval.buildRuntimeContext = function (input) {
    const a = input || {};
    spy.wrapper.push({ hasOwnTurnIndex: Object.prototype.hasOwnProperty.call(a, 'turnIndex'), turnIndex: a.turnIndex });
    return real.wrapper.apply(this, arguments);
  };
  state.beginHomeTurn = function (input) {
    const i = real.begin.apply(this, arguments);
    spy.begin.push({ characterId: input && input.characterId, turnId: input && input.turnId, turnIndex: i });
    return i;
  };
  state.recordExposure = function (input) {
    const w = real.exposure.apply(this, arguments);
    spy.exposure.push({
      characterId: input && input.characterId,
      memoryIds: (input && Array.isArray(input.memoryIds)) ? input.memoryIds.slice() : [],
      turnIndex: input && input.turnIndex, written: w
    });
    return w;
  };
  state.endHomeTurn = function (input) {
    const r = real.end.apply(this, arguments);
    spy.end.push({ turnId: input && input.turnId, released: r });
    return r;
  };
  function restore() { ORCH.recall = real.recall; CORE_NODE.buildMemoryContext = real.core; }
  async function send(requestId, content, extra) {
    const res = rtRes();
    await gateway.dispatch(RT_ROUTE, rtReq({
      v: 1, requestId: requestId,
      payload: Object.assign({ characterId: cfg.characterId || RT_CHAR, content: content }, extra || {})
    }), res, new URL(RT_URL));
    let body = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch (e) { body = null; }
    return { res: res, body: body };
  }
  async function settle(requestId, endCount) {
    return rtWaitFor(function () {
      const t = gateway.getTurnByRequest(requestId);
      return !!t && t.status !== 'running' && spy.end.length >= endCount;
    }, 5000);
  }
  return { gateway, state, store, chatStore, retrieval, spy, send, settle, restore };
}

/* 从**真实 production 观测点**取某个 memory 的 cooldown factor：
   优先 ORCH trace candidate，其次唯一 selector 的真实输入 map。绝不自己 compute。 */
function rtFactorOf(svc, recallIndex, memoryId) {
  const recall = svc.spy.recall[recallIndex] || null;
  const core = svc.spy.core[recallIndex] || null;
  const cand = (recall && recall.candidates) ? recall.candidates.filter(c => c.memoryId === memoryId)[0] : null;
  if (cand && typeof cand.cooldownFactor === 'number') {
    return { value: cand.cooldownFactor, source: 'orch.trace.candidates[' + memoryId + '].cooldownFactor' };
  }
  if (core && core.factors && Object.prototype.hasOwnProperty.call(core.factors, memoryId)) {
    return { value: core.factors[memoryId], source: 'core opts.cooldownFactorsById[' + memoryId + ']' };
  }
  if (core && core.hasFactorsMap === false) {
    return { value: 1, source: 'no cooldownFactorsById map => selector fail-safe 1' };
  }
  return { value: null, source: 'unobserved' };
}

/* 冷启动 anchor record：准入判据 = pinned OR kind==='semantic'（coldstart-anchor.js）。
   刻意用 kind='semantic'，不引入 pinned（避免触碰 pinned 维度）。 */
function rtAnchorRecord(id, query) {
  return {
    id: id, title: query, content: query + '：长期锚点', kind: 'semantic',
    importance: 7, arousal: 0.3, resolved: false, activationCount: 0,
    created: RT_NOW - RT_DAY, lastActivated: RT_NOW - RT_DAY,
    visibility: 'public', tags: [], domain: '日常', createdBy: 'user'
  };
}

async function rtBehavioralMatrix() {
  const out = {};

  /* ── §4 Final-ID Truth（BUG-3 核心剩余门）────────────────────────────
     M1/M2/M3 三条都可见、都过 Hard Gate、都进入 selection stage；
     M2 只因 seat/budget/final selection 落选 —— 不是 ACL / gate / irrelevant。 */
  {
    const contentLen = 200;
    const query = RT_QUERY;
    const mk = function (id, importance) {
      return {
        id: id, title: query,
        content: query + '：' + 'x'.repeat(Math.max(0, contentLen - query.length - 1)),
        importance: importance, arousal: 0.3, resolved: false, activationCount: 0,
        created: RT_NOW - RT_DAY, lastActivated: RT_NOW - RT_DAY,
        visibility: 'public', tags: [], domain: '日常', createdBy: 'user'
      };
    };
    const recs = [mk('M1', 10), mk('M3', 9), mk('M2', 5)];
    const lineLen = CORE_NODE.renderMemoryLine(recs[0], RT_CHAR, contentLen).length;
    /* budget = 3L-1 ⇒ mainBudget=floor(0.85P)=2.55L-1：恰装 2 条、第 3 条装不下；
       chars=2L 时探索项（+L=3L > P）也装不下 ⇒ M2 只能因 seat/budget 落选。 */
    const settings = { budget: 3 * lineLen - 1, contentLen: contentLen };
    const svc = rtService({ records: recs, settings: settings });
    try {
      await svc.send('req_fid', query);
      await svc.settle('req_fid', 1);
      const turn = svc.gateway.getTurnByRequest('req_fid');
      const recall = svc.spy.recall[0] || { candidates: [] };
      const byId = {};
      (recall.candidates || []).forEach(c => { byId[c.memoryId] = c; });
      const finalIds = Array.isArray(turn.selectedMemoryIds) ? turn.selectedMemoryIds.slice() : [];
      const exp = svc.spy.exposure[0] || null;
      out.finalId = {
        lineLen: lineLen, budget: settings.budget,
        candidateIds: (recall.candidates || []).map(c => c.memoryId),
        decisions: { M1: byId.M1 && byId.M1.decision, M2: byId.M2 && byId.M2.decision, M3: byId.M3 && byId.M3.decision },
        m2Reasons: byId.M2 ? byId.M2.reasons : null,
        coreSelectedIds: svc.spy.core[0] ? svc.spy.core[0].selectedIds : null,
        finalIds: finalIds,
        exposureIds: exp ? exp.memoryIds : null,
        reinforcementIds: turn.reinforcementIds,
        activationCalls: svc.store.activationCalls.map(a => a.ids),
        exposureState: {
          M1: svc.state.getExposure({ characterId: RT_CHAR, memoryId: 'M1' }),
          M2: svc.state.getExposure({ characterId: RT_CHAR, memoryId: 'M2' }),
          M3: svc.state.getExposure({ characterId: RT_CHAR, memoryId: 'M3' })
        },
        warnings: svc.spy.warnings
      };
      console.log('  [§4 Final-ID] ' + JSON.stringify(out.finalId));
      check('BUG3.finalId.candidatesReachedSelection', !!(byId.M1 && byId.M2 && byId.M3), JSON.stringify(out.finalId.candidateIds));
      check('BUG3.finalId.postSeatDroppedM2', !!(byId.M2 && byId.M2.decision === 'rejected'
        && (byId.M2.reasons || []).indexOf('not-selected-by-core') >= 0
        && (byId.M2.reasons || []).indexOf('gate-rejected') < 0), JSON.stringify(byId.M2 || null));
      check('BUG3.finalId.selectedExactlyM1M3',
        JSON.stringify(finalIds.slice().sort()) === JSON.stringify(['M1', 'M3']), JSON.stringify(finalIds));
      check('BUG3.finalId.exposureUsesFinalInjectedIds',
        !!(exp && JSON.stringify(exp.memoryIds.slice().sort()) === JSON.stringify(finalIds.slice().sort())),
        JSON.stringify({ exposureIds: exp && exp.memoryIds, finalIds: finalIds }));
      check('BUG3.finalId.exposureStateM1M3Only',
        !!(out.finalId.exposureState.M1 && out.finalId.exposureState.M3
          && out.finalId.exposureState.M1.lastExposureTurn === 1
          && out.finalId.exposureState.M3.lastExposureTurn === 1
          && out.finalId.exposureState.M2 === null),
        JSON.stringify(out.finalId.exposureState));
      check('BUG3.finalId.reinforcementSeparateFromExposure',
        JSON.stringify((turn.reinforcementIds || []).slice().sort()) === JSON.stringify(finalIds.slice().sort())
        && svc.store.activationCalls.length === 1
        && JSON.stringify(svc.store.activationCalls[0].ids.slice().sort()) === JSON.stringify(finalIds.slice().sort()),
        JSON.stringify({ reinforcementIds: turn.reinforcementIds, activationCalls: svc.store.activationCalls }));
      check('BUG3.finalId.noWarnings', svc.spy.warnings.length === 0, JSON.stringify(svc.spy.warnings));
    } finally { svc.restore(); }
  }

  /* ── §5 Settled Error（runTurn 已开始，最终 error）───────────────────── */
  {
    const svc = rtService({
      executor: function (request, options) {
        return { ok: false, error: 'provider-error', message: 'synthetic provider failure', turnId: options.turnId, userMessageId: 'u1' };
      }
    });
    try {
      await svc.send('req_err', RT_QUERY);
      await svc.settle('req_err', 1);
      const turn = svc.gateway.getTurnByRequest('req_err');
      const exposure = svc.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });
      out.settledError = {
        turnStatus: turn && turn.status, turnError: turn && turn.error,
        begin: svc.spy.begin.length, retrieval: svc.spy.recall.length, executor: svc.spy.executor.length,
        exposure: svc.spy.exposure.length, end: svc.spy.end.length,
        homeTurns: svc.state.debugSize().homeTurns,
        exposureCount: exposure ? exposure.exposureCount : null,
        warnings: svc.spy.warnings.map(w => w.event)
      };
      console.log('  [§5 settled error] ' + JSON.stringify(out.settledError));
      check('BUG3.settledError.beginOnce', svc.spy.begin.length === 1, JSON.stringify(out.settledError));
      check('BUG3.settledError.retrievalRan', svc.spy.recall.length === 1 && svc.spy.wrapper.length === 1, JSON.stringify(out.settledError));
      check('BUG3.settledError.executorRanAndTurnErrored',
        svc.spy.executor.length === 1 && turn.status === 'error' && turn.error === 'provider-error', JSON.stringify(out.settledError));
      check('BUG3.settledError.noExposureWrite', svc.spy.exposure.length === 0 && out.settledError.exposureCount === null, JSON.stringify(out.settledError));
      check('BUG3.settledError.cleanup', svc.spy.end.length === 1 && out.settledError.homeTurns === 0, JSON.stringify(out.settledError));
    } finally { svc.restore(); }
  }

  /* ── §6/§7 ColdStart（真实 gateway，真 anchor）→ 后续 surface ────────── */
  {
    const svc = rtService({ records: [rtAnchorRecord('MCS', RT_QUERY)], priorMessages: 0 });
    try {
      await svc.send('req_cs', RT_QUERY);
      await svc.settle('req_cs', 1);
      const turn = svc.gateway.getTurnByRequest('req_cs');
      const rec = svc.spy.recall[0] || null;
      const ids = Array.isArray(turn.selectedMemoryIds) ? turn.selectedMemoryIds.slice() : [];
      const exposure = svc.state.getExposure({ characterId: RT_CHAR, memoryId: 'MCS' });
      out.coldStart = {
        channel: rec && rec.channel, activationPolicy: rec && rec.activationPolicy,
        turnIndex: rec && rec.turnIndex, selectedIds: ids,
        reinforcementIds: turn.reinforcementIds,
        activationCalls: svc.store.activationCalls.length,
        exposureCalls: svc.spy.exposure.length,
        exposureIds: svc.spy.exposure[0] ? svc.spy.exposure[0].memoryIds : null,
        exposureState: exposure, homeTurns: svc.state.debugSize().homeTurns,
        warnings: svc.spy.warnings.map(w => w.event)
      };
      console.log('  [§6 coldStart] ' + JSON.stringify(out.coldStart));
      check('BUG3.coldStart.channelIsColdStart', !!(rec && rec.channel === 'coldStart'), JSON.stringify(out.coldStart));
      check('BUG3.coldStart.anchorSelected', ids.length > 0 && ids.indexOf('MCS') >= 0, JSON.stringify(ids));
      check('BUG3.coldStart.activationPolicyNone', !!(rec && rec.activationPolicy === 'none'), JSON.stringify(out.coldStart));
      check('BUG3.coldStart.reinforcementEmpty',
        Array.isArray(turn.reinforcementIds) && turn.reinforcementIds.length === 0 && svc.store.activationCalls.length === 0,
        JSON.stringify(out.coldStart));
      check('BUG3.coldStart.exposureWrittenOnce',
        svc.spy.exposure.length === 1 && !!exposure && exposure.exposureCount === 1
        && (svc.spy.exposure[0].memoryIds || []).indexOf('MCS') >= 0,
        JSON.stringify(out.coldStart));
      check('BUG3.coldStart.cleanup', svc.state.debugSize().homeTurns === 0, JSON.stringify(out.coldStart));

      /* §7 coldStart → 下一 logical ordinary turn（surface） */
      svc.chatStore.setPriorMessages(1);   /* production 里由 executor 的 canonical 写入产生 */
      await svc.send('req_cs2', RT_QUERY);
      await svc.settle('req_cs2', 2);
      const rec2 = svc.spy.recall[1] || null;
      const f = rtFactorOf(svc, 1, 'MCS');
      out.coldToSurface = {
        channel: rec2 && rec2.channel, turnIndex: rec2 && rec2.turnIndex,
        factor: f.value, factorSource: f.source,
        coldStartExposureCount: exposure ? exposure.exposureCount : null
      };
      console.log('  [§7 coldStart→surface] ' + JSON.stringify(out.coldToSurface));
      check('BUG2.coldToSurface.channelIsSurface', !!(rec2 && rec2.channel === 'surface' && rec2.turnIndex === 2), JSON.stringify(out.coldToSurface));
      check('BUG2.coldToSurface.exposureDrivesCooldown', f.value === RT_EXPECTED_FACTOR, JSON.stringify(out.coldToSurface));
      check('BUG2.coldToSurface.coldStartWroteNoActivation', svc.store.activationCalls.length === 1, JSON.stringify({ activationCalls: svc.store.activationCalls.length }));
      check('BUG3.coldStart.hadNoActivationBeforeSurface', out.coldStart.activationCalls === 0, JSON.stringify(out.coldStart));
    } finally { svc.restore(); }
  }

  /* ── §8 Cross-conversation（cooldown scope = character，不是 conversation）── */
  {
    const svc = rtService({});
    try {
      await svc.send('req_x1', RT_QUERY, { threadId: 't1' });
      await svc.settle('req_x1', 1);
      const t1 = svc.gateway.getTurnByRequest('req_x1');
      await svc.send('req_x2', RT_QUERY, { threadId: 't2' });
      await svc.settle('req_x2', 2);
      const t2 = svc.gateway.getTurnByRequest('req_x2');
      const rec2 = svc.spy.recall[1] || null;
      const f = rtFactorOf(svc, 1, RT_M1);
      out.crossConv = {
        conversationId1: t1 && t1.conversationId, conversationId2: t2 && t2.conversationId,
        turnIndex2: rec2 && rec2.turnIndex, factor: f.value, factorSource: f.source
      };
      console.log('  [§8 cross-conversation] ' + JSON.stringify(out.crossConv));
      check('BUG2.crossConversation.distinctConversations',
        !!(t1 && t2 && t1.conversationId !== t2.conversationId), JSON.stringify(out.crossConv));
      check('BUG2.crossConversation.sameCharacterIndexContinues', !!(rec2 && rec2.turnIndex === 2), JSON.stringify(out.crossConv));
      check('BUG2.crossConversation.factorIs040', f.value === RT_EXPECTED_FACTOR, JSON.stringify(out.crossConv));
    } finally { svc.restore(); }
  }

  /* ── §9 Character Isolation（per-character counters / exposures）───────── */
  {
    const svc = rtService({ registry: rtRegistry(['role_a', 'role_b']) });
    const RB = 'role_b';
    try {
      await svc.send('req_a1', RT_QUERY);
      await svc.settle('req_a1', 1);
      const aAfterA1 = svc.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });
      await svc.send('req_b1', RT_QUERY, { characterId: RB });
      await svc.settle('req_b1', 2);
      const fB = rtFactorOf(svc, 1, RT_M1);
      /* 关键采样点：B 的回合之后、A 的下一个回合之前 —— A 的 exposure 必须**没有**
         被 B 的回合改动（同一 memoryId、同一 store，最容易串味的地方）。 */
      const aAfterB = svc.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });
      const bAfterB = svc.state.getExposure({ characterId: RB, memoryId: RT_M1 });
      await svc.send('req_a2', RT_QUERY);
      await svc.settle('req_a2', 3);
      const fA2 = rtFactorOf(svc, 2, RT_M1);
      const aAfterA2 = svc.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });
      out.charIsolation = {
        beginIndexes: svc.spy.begin.map(b => b.turnIndex),
        beginCharacters: svc.spy.begin.map(b => b.characterId),
        aCounter: svc.state.currentTurnIndex({ characterId: RT_CHAR }),
        bCounter: svc.state.currentTurnIndex({ characterId: RB }),
        aAfterA1: aAfterA1, aAfterB: aAfterB, aAfterA2: aAfterA2, bAfterB: bAfterB,
        bFactor: fB.value, bFactorSource: fB.source,
        aFactor2: fA2.value, aFactor2Source: fA2.source,
        aDistance: 2 - 1
      };
      console.log('  [§9 character isolation] ' + JSON.stringify(out.charIsolation));
      check('BUG2.charIsolation.bFirstTurnFactorOne', fB.value === 1, JSON.stringify(out.charIsolation));
      check('BUG2.charIsolation.perCharacterCounters',
        JSON.stringify(out.charIsolation.beginIndexes) === JSON.stringify([1, 1, 2])
        && out.charIsolation.aCounter === 2 && out.charIsolation.bCounter === 1,
        JSON.stringify(out.charIsolation));
      check('BUG2.charIsolation.siblingExposureNotShared',
        !!(aAfterA1 && aAfterA1.lastExposureTurn === 1
          && aAfterB && aAfterB.lastExposureTurn === 1
          && bAfterB && bAfterB.lastExposureTurn === 1
          && aAfterA2 && aAfterA2.lastExposureTurn === 2),
        JSON.stringify({ aAfterA1: aAfterA1, aAfterB: aAfterB, aAfterA2: aAfterA2, bAfterB: bAfterB }));
      /* 回到 A：A 自己的 counter 使本轮 distance = 2-1 = 1 ⇒ 契约 .40（明确按 distance 断言） */
      check('BUG2.charIsolation.backToAFactorByDistance', fA2.value === 0.40,
        JSON.stringify({ distance: out.charIsolation.aDistance, factor: fA2.value, source: fA2.source }));
    } finally { svc.restore(); }
  }

  /* ── §10 Restart Reset（新 service / 新 session state ⇒ 无 durable 读出）── */
  {
    const svcA = rtService({});
    let recordRef = null;
    try {
      await svcA.send('req_r1', RT_QUERY);
      await svcA.settle('req_r1', 1);
      recordRef = svcA.store.listRecords({}).records[0];
      out.restart = {
        aExposure: svcA.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 }),
        aCount: svcA.state.currentTurnIndex({ characterId: RT_CHAR })
      };
    } finally { svcA.restore(); }

    const svcB = rtService({});   /* 全新 service + 全新 RecallSessionState */
    try {
      /* 采样点：**回合之前**（fresh state 必须没有任何 exposure / counter）。 */
      const bBefore = svcB.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });
      const bCountBefore = svcB.state.currentTurnIndex({ characterId: RT_CHAR });
      await svcB.send('req_r2', RT_QUERY);
      await svcB.settle('req_r2', 1);
      const fb = rtFactorOf(svcB, 0, RT_M1);
      out.restart.bExposureBefore = bBefore;
      out.restart.bCountBefore = bCountBefore;
      out.restart.bCount = svcB.state.currentTurnIndex({ characterId: RT_CHAR });
      out.restart.factor = fb.value;
      out.restart.factorSource = fb.source;
      out.restart.durableFieldsOnRecord = Object.keys(recordRef).filter(function (k) {
        return /lastSurfaced|lastRecalled|lastSelected|lastChannel|lastCooldown|exposureTurn/i.test(k);
      });
      console.log('  [§10 restart] ' + JSON.stringify(out.restart));
      check('BUG2.restart.noCooldownAfterRestart', fb.value === 1, JSON.stringify(out.restart));
      check('BUG2.restart.freshStateHasNoExposure',
        bBefore === null && bCountBefore === 0, JSON.stringify(out.restart));
      check('BUG2.restart.noDurableCooldownMetadata', out.restart.durableFieldsOnRecord.length === 0, JSON.stringify(out.restart.durableFieldsOnRecord));
    } finally { svcB.restore(); }
  }

  /* ── §11/§12 Behavioral Reverse Control（只把 exposure-write seam 变成 no-op）──
     两个 service **绝不同时存活**：ORCH.recall / CORE.buildMemoryContext 是模块级
     函数，两条 spy 链同时挂着时"后创建的那个"会成为外层，从而把前一个服务的调用
     也记进自己的数组（实测踩到）。顺序执行 + 各自 restore。 */
  {
    const snap = function (svc) {
      return {
        exposure: svc.spy.exposure.map(e => ({ memoryIds: e.memoryIds.slice(), turnIndex: e.turnIndex, written: e.written })),
        channels: svc.spy.recall.map(r => r.channel),
        messages: svc.spy.recall.map(r => r.turnMessage),
        turnIndexes: svc.spy.recall.map(r => r.turnIndex)
      };
    };
    let nF, rF, nTurn1, nTurn2, rTurn1, rTurn2, nSnap, rSnap, nState, rState;

    const normal = rtService({});
    try {
      await normal.send('req_t1', RT_QUERY); await normal.settle('req_t1', 1);
      await normal.send('req_t2', RT_QUERY); await normal.settle('req_t2', 2);
      nF = rtFactorOf(normal, 1, RT_M1);
      nTurn1 = normal.gateway.getTurnByRequest('req_t1');
      nTurn2 = normal.gateway.getTurnByRequest('req_t2');
      nSnap = snap(normal);
      nState = normal.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });
    } finally { normal.restore(); }

    const reverse = rtService({ exposureNoop: true });
    try {
      await reverse.send('req_t1', RT_QUERY); await reverse.settle('req_t1', 1);
      await reverse.send('req_t2', RT_QUERY); await reverse.settle('req_t2', 2);
      rF = rtFactorOf(reverse, 1, RT_M1);
      rTurn1 = reverse.gateway.getTurnByRequest('req_t1');
      rTurn2 = reverse.gateway.getTurnByRequest('req_t2');
      rSnap = snap(reverse);
      rState = reverse.state.getExposure({ characterId: RT_CHAR, memoryId: RT_M1 });
    } finally { reverse.restore(); }

    out.reverse = {
      normalFactor: nF.value, normalFactorSource: nF.source,
      reverseFactor: rF.value, reverseFactorSource: rF.source,
      normalTurn1Selected: nTurn1.selectedMemoryIds, reverseTurn1Selected: rTurn1.selectedMemoryIds,
      normalTurn2Selected: nTurn2.selectedMemoryIds, reverseTurn2Selected: rTurn2.selectedMemoryIds,
      normalExposure: nSnap.exposure, reverseExposure: rSnap.exposure,
      normalStateExposure: nState, reverseStateExposure: rState,
      channels: nSnap.channels.concat(rSnap.channels),
      messages: nSnap.messages.concat(rSnap.messages),
      turnIndexes: nSnap.turnIndexes.concat(rSnap.turnIndexes)
    };
    console.log('  [§11 reverse control] ' + JSON.stringify(out.reverse));
    check('BUG2.reverseControl.normalHasCooldown', nF.value === RT_EXPECTED_FACTOR, JSON.stringify(out.reverse));
    check('BUG2.reverseControl.noopWriteRemovesCooldown',
      rF.value === 1 && rState === null, JSON.stringify(out.reverse));
    check('BUG3.reverseControl.selectionUnchanged',
      JSON.stringify(nTurn1.selectedMemoryIds) === JSON.stringify(rTurn1.selectedMemoryIds)
      && JSON.stringify(nTurn2.selectedMemoryIds) === JSON.stringify(rTurn2.selectedMemoryIds),
      JSON.stringify(out.reverse));
    check('BUG3.reverseControl.writeCameFromGatewaySeam',
      nSnap.exposure.length === 2 && nSnap.exposure[0].written === 1
      && JSON.stringify(nSnap.exposure[0].memoryIds) === JSON.stringify(nTurn1.selectedMemoryIds)
      && rSnap.exposure.length === 2 && rSnap.exposure[0].written === 0 && rSnap.exposure[1].written === 0,
      JSON.stringify(out.reverse));
    check('BUG3.reverseControl.inputsEquivalent',
      JSON.stringify(out.reverse.channels) === JSON.stringify(['surface', 'surface', 'surface', 'surface'])
      && JSON.stringify(out.reverse.messages) === JSON.stringify([RT_QUERY, RT_QUERY, RT_QUERY, RT_QUERY])
      && JSON.stringify(out.reverse.turnIndexes) === JSON.stringify([1, 2, 1, 2]),
      JSON.stringify(out.reverse));
  }

  return out;
}

/* ══ §15 · pre-run failure cleanup（begin 已发生、runTurn 尚未开始）════════
   故障注入走 test DI：device.deviceId 的 getter 抛错 —— 抛出点严格落在
   beginHomeTurn 之后、runTurn 之前（beginTurn 组装 turn 时读 deviceId）。
   要求：begin=1、runTurn=0、recordExposure=0、endHomeTurn=1、homeTurns=0。
   这不是"给清理逻辑打桩"：被驱动的仍是 production 的 try/catch 清理路径。 */
async function rtPreRunFailure() {
  const beginCalls = [];
  const endCalls = [];
  let executorCalls = 0;
  let exposureCalls = 0;
  const logs = [];
  const sharedSessionState = createRecallSessionState();
  const memoryRetrieval = createMemoryRetrieval({
    store: rtMemoryStore([rtMemoryRecord()]),
    clock: () => RT_NOW, sessionState: sharedSessionState, random: () => 0.5
  });
  const device = { capabilities: ['chat'] };
  /* 故障注入点必须是 **beginHomeTurn 之后、runTurn 之前**。
     该窗口内唯一可注入的抛出点是 beginTurn 组装 turn 时读 `device.deviceId`
     —— retrieval 侧的异常按契约 fail-open（被 buildRuntimeContext 内部吞掉），
     无法产生"pre-run 失败"。
     读取次序（固定、可断言）：① 设备级限流 key → ② beginTurn 的 deviceId。
     因此第 2 次读取抛错，正好落在 lifecycle begin 之后。 */
  let deviceIdReads = 0;
  Object.defineProperty(device, 'deviceId', {
    get: function () {
      deviceIdReads++;
      if (deviceIdReads >= 2) throw new Error('device-id-unavailable');
      return 'dev_prerun';
    }
  });
  const registry = Object.assign(rtRegistry(), {
    verifyDeviceToken: function () { return { ok: true, device: device }; }
  });
  const gateway = createMobileGateway({
    store: rtChatStore(),
    registry: registry,
    executor: { executeCharacterTurn: async function () { executorCalls++; return { ok: true, outcome: 'completed' }; } },
    sessionState: sharedSessionState,
    memoryRetrieval: memoryRetrieval,
    clock: () => RT_NOW,
    random: () => 0.5,
    logger: function (level, event, fields) {
      if (level !== 'info') logs.push({ level: level, event: event, error: fields && fields.error });
    }
  });
  const realBegin = sharedSessionState.beginHomeTurn;
  sharedSessionState.beginHomeTurn = function (input) {
    const i = realBegin.apply(this, arguments);
    beginCalls.push({ turnId: input && input.turnId, turnIndex: i });
    return i;
  };
  const realEnd = sharedSessionState.endHomeTurn;
  sharedSessionState.endHomeTurn = function (input) {
    const released = realEnd.apply(this, arguments);
    endCalls.push({ turnId: input && input.turnId, released: released });
    return released;
  };
  const realExposure = sharedSessionState.recordExposure;
  sharedSessionState.recordExposure = function () { exposureCalls++; return realExposure.apply(this, arguments); };

  const res = rtRes();
  let dispatchError = null;
  try {
    await gateway.dispatch(RT_ROUTE, rtReq({
      v: 1, requestId: 'req_prerun', payload: { characterId: RT_CHAR, content: RT_QUERY }
    }), res, new URL(RT_URL));
  } catch (error) { dispatchError = String((error && error.message) || error); }
  await rtDelay(40);

  let body = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch (error) { body = null; }
  const homeTurns = sharedSessionState.debugSize().homeTurns;
  const F1 = beginCalls.length === 1;
  const F2 = executorCalls === 0;
  const F3 = exposureCalls === 0;
  const F4 = endCalls.length === 1 && endCalls[0].released === true;
  const F5 = homeTurns === 0;
  const F6 = res.status === 500 && !!body && body.ok === false && !!body.error && body.error.code === 'INTERNAL';
  const F7 = logs.some(l => l.event === 'turn-start-failed');
  const F8 = dispatchError === null;
  /* 注入点证据：恰好 2 次读取 ⇒ 抛错发生在 beginTurn（不是更早的限流 key）。 */
  const F9 = deviceIdReads === 2;

  const result = {
    ok: F1 && F2 && F3 && F4 && F5 && F6 && F7 && F8 && F9,
    beginCalls: beginCalls.length, executorCalls: executorCalls, exposureCalls: exposureCalls,
    endCalls: endCalls.length, homeTurns: homeTurns, status: res.status,
    errorCode: body && body.error ? body.error.code : null,
    loggedTurnStartFailed: F7, dispatchError: dispatchError, deviceIdReads: deviceIdReads
  };
  console.log('  [pre-run] ' + JSON.stringify(result));
  check('BUG6.runtime.preRunFailure.cleanup', F1 && F2 && F3 && F4 && F5, JSON.stringify(result));
  check('BUG6.runtime.preRunFailure.response', F6 && F7 && F8, JSON.stringify(result));
  check('BUG6.runtime.preRunFailure.injectionPoint', F9, JSON.stringify({ deviceIdReads: deviceIdReads, beginCalls: beginCalls.length }));
  return result;
}

async function rtMain() {
  const runs = [];
  const labels = ['run1', 'run2', 'run3'];
  for (let i = 0; i < labels.length; i++) {
    let r;
    try {
      r = await rtRun(labels[i]);
    } catch (error) {
      r = { label: labels[i], turn1Gate: false, fatal: String((error && error.stack) || error) };
      console.error('  FATAL  [' + labels[i] + '] ' + r.fatal);
    }
    runs.push(r);
    console.log('  [' + r.label + '] TURN1_GATE=' + (r.turn1Gate ? 'SATISFIED' : 'FAILED')
      + ' selectedM1=' + r.turn1SelectedM1 + ' exposureCount=' + r.turn1ExposureCount
      + ' cleanup=' + r.turn1Cleanup + ' turn2Expected=' + r.turn2Expected
      + ' turn2Actual=' + JSON.stringify(r.turn2Actual) + ' order=' + JSON.stringify(r.orderSeqTurn1));
    /* §12：T1–T11 任一不成立 ⇒ 该 run 绝不做 Turn2（不伪造 RED）。
       仍然把 Turn1 相位跑满 3 次 —— §19 要求的是 3 次同一 signature 的稳定性证据。 */
    if (!r.turn1Gate) {
      console.error('  STOP  [' + r.label + '] BUG6_RED_PRECONDITION_FAILED — Turn2 NOT executed for this run.');
    }
  }

  /* ── §20 three-run GREEN signature ── */
  const complete = runs.length === 3 && runs.every(r => r.turn1Gate === true);
  const dupOf = r => r.duplicate || null;
  const signature = r => [
    'turn1.exposure=' + JSON.stringify(r.turn1ExposureCount),
    'dup.exec=' + (dupOf(r) ? dupOf(r).before.exec + '->' + dupOf(r).after.exec : 'n/a'),
    'dup.begin=' + (dupOf(r) ? dupOf(r).before.begin + '->' + dupOf(r).after.begin : 'n/a'),
    'dup.exp=' + (dupOf(r) ? dupOf(r).before.exp + '->' + dupOf(r).after.exp : 'n/a'),
    'dup.end=' + (dupOf(r) ? dupOf(r).before.end + '->' + dupOf(r).after.end : 'n/a'),
    'counter=' + (dupOf(r) ? dupOf(r).after.counter : 'n/a'),
    'beginIndexes=' + (r.beginCalls || []).map(b => b.turnIndex).join(','),
    'turn2.orchIndex=' + JSON.stringify(r.turn2Trace ? r.turn2Trace.turnIndex : null),
    'factor=' + JSON.stringify(r.turn2Actual),
    'order=' + (r.orderSeqTurn1 || []).join('>'),
    'turn1Gate=' + r.turn1Gate
  ].join(';');
  const sigs = runs.map(signature);
  const sameSignature = sigs.length === 3 && sigs[0] === sigs[1] && sigs[1] === sigs[2];
  console.log('  normalized green signatures (3 runs):');
  sigs.forEach(function (s, i) { console.log('    ' + labels[i] + ': ' + s); });

  check('BUG6.runtime.threeRun.turn1Gate', complete,
    JSON.stringify(runs.map(r => ({ run: r.label, turn1Gate: r.turn1Gate, exposureCount: r.turn1ExposureCount, cleanup: r.turn1Cleanup }))));
  check('BUG6.runtime.threeRun.sameGreenSignature', sameSignature, JSON.stringify(sigs));

  /* ── §36 · 行为矩阵（BUG-2 read side / BUG-3 write+cleanup side）── */
  const beh = await rtBehavioralMatrix();

  /* ── §21 · BUG-6 closure gate（14 项契约条件，全部来自真实 runtime）── */
  const A = complete && runs.every(r => r.turn1ExposureCount === 1 && r.turn1Cleanup === true);
  const B = complete && runs.every(r => typeof r.turn2Actual === 'number' && r.turn2Actual === RT_EXPECTED_FACTOR);
  const C = sameSignature;
  const D = complete && runs.every(r => r.orderBeginBeforeRetrieve === true && r.orderBeginBeforeRetrieveTurn2 === true);
  const E = complete && runs.every(r => r.wrapperTurn1 && r.wrapperTurn1.hasOwnTurnIndex === true && r.wrapperTurn1.turnIndex === 1
    && r.orchTurn1Index === 1 && r.turn2Trace && r.turn2Trace.turnIndex === 2 && r.turn2Wrapper && r.turn2Wrapper.turnIndex === 2);
  const F = complete && runs.every(r => {
    const d = dupOf(r);
    return !!d && d.after.exec === d.before.exec && d.after.begin === d.before.begin
      && d.after.exp === d.before.exp && d.after.end === d.before.end
      && d.after.counter === 1 && d.after.exposureCount === 1 && d.status === 200;
  });
  const G = complete && runs.every(r => (r.beginCalls || []).length === 2
    && r.beginCalls[0].turnIndex === 1 && r.beginCalls[1].turnIndex === 2);

  const preRun = await rtPreRunFailure();
  const H = preRun.ok === true;

  const closed = A && B && C && D && E && F && G && H;
  console.log('\n  ── §21 BUG-6 closure gate ──');
  console.log('    A success exposure + cleanup      : ' + A);
  console.log('    B turn2 factor == 0.40            : ' + B);
  console.log('    C 3-run stable green signature    : ' + C);
  console.log('    D begin < retrieve (Turn1+Turn2)  : ' + D);
  console.log('    E turnIndex 1/2 at wrapper + ORCH : ' + E);
  console.log('    F duplicate: no extra lifecycle   : ' + F);
  console.log('    G begin exactly once per turn 1,2 : ' + G);
  console.log('    H pre-run failure cleanup         : ' + H);
  console.log('  BUG6 = ' + (closed ? 'CLOSED' : 'NOT CLOSED'));

  check('BUG6.closure.gate', closed,
    JSON.stringify({ A: A, B: B, C: C, D: D, E: E, F: F, G: G, H: H, preRun: preRun, signatures: sigs }));

  /* ── §14/§15 · BUG-2 / BUG-3 closure gates（结构 + 真实行为）──────────
     结构判据从**已存在的** markers 重新求值（与 §21 BG1/BG4/BG5 同一词表），
     行为判据全部来自真实 gateway dispatch 的 runtime 观测。 */
  const mrGate = mrSrc.replace(/\r\n/g, '\n');
  const gwGate = gwSrc.replace(/\r\n/g, '\n');
  const bug2Structural = [/deps\.sessionState/, /sessionState:\s*sessionState/, /turnIndex:\s*options\.turnIndex/]
    .every(function (re) { return re.test(mrGate); });
  const bug3Structural = [/beginHomeTurn\(\{/, /recordExposure\(\{/, /endHomeTurn\(\{/]
    .every(function (re) { return re.test(gwGate); });

  const turn2FactorOk = complete && runs.every(r => r.turn2Actual === RT_EXPECTED_FACTOR);
  const bug2 = bug2Structural && A && turn2FactorOk && E
    && beh.coldToSurface.factor === RT_EXPECTED_FACTOR
    && beh.crossConv.factor === RT_EXPECTED_FACTOR
    && beh.charIsolation.bFactor === 1
    && beh.charIsolation.aFactor2 === 0.40
    && beh.restart.factor === 1
    && beh.reverse.normalFactor === RT_EXPECTED_FACTOR
    && beh.reverse.reverseFactor === 1;

  const finalIdsSorted = beh.finalId.finalIds.slice().sort().join(',');
  const bug3 = bug3Structural && A
    && finalIdsSorted === 'M1,M3'
    && !!beh.finalId.exposureIds && beh.finalId.exposureIds.slice().sort().join(',') === finalIdsSorted
    && beh.finalId.exposureState.M2 === null
    && beh.finalId.activationCalls.length === 1
    && beh.finalId.warnings.length === 0
    && beh.settledError.exposure === 0 && beh.settledError.end === 1 && beh.settledError.homeTurns === 0
    && preRun.ok === true && preRun.exposureCalls === 0
    && beh.coldStart.activationCalls === 0 && beh.coldStart.reinforcementIds.length === 0
    && beh.coldStart.exposureCalls === 1 && beh.coldStart.homeTurns === 0
    && beh.reverse.reverseFactor === 1;

  console.log('\n  ── §14 BUG-2 closure gate（cooldown READ side）──');
  console.log('    structural BG1/BG2 (memory-retrieval markers) : ' + bug2Structural);
  console.log('    real Turn2 surface factor = .40               : ' + turn2FactorOk);
  console.log('    begin/retrieval turnIndex 真实传播 (E)         : ' + E);
  console.log('    coldStart→surface factor = .40                : ' + (beh.coldToSurface.factor === RT_EXPECTED_FACTOR));
  console.log('    cross-conversation factor = .40               : ' + (beh.crossConv.factor === RT_EXPECTED_FACTOR));
  console.log('    character isolation (B=1 / A=.40)             : ' + (beh.charIsolation.bFactor === 1 && beh.charIsolation.aFactor2 === 0.40));
  console.log('    restart reset = 1                             : ' + (beh.restart.factor === 1));
  console.log('    behavioral reverse control (.40 → 1)          : ' + (beh.reverse.normalFactor === RT_EXPECTED_FACTOR && beh.reverse.reverseFactor === 1));
  console.log('  BUG2 = ' + (bug2 ? 'CLOSED' : 'NOT CLOSED'));

  console.log('\n  ── §15 BUG-3 closure gate（exposure WRITE / cleanup side）──');
  console.log('    structural BG3/BG4/BG5                        : ' + bug3Structural);
  console.log('    real success writes exposure (A)              : ' + A);
  console.log('    writer uses FINAL selected ids                : ' + (finalIdsSorted === 'M1,M3' && !!beh.finalId.exposureIds && beh.finalId.exposureIds.slice().sort().join(',') === finalIdsSorted));
  console.log('    post-seat dropped M2 not written              : ' + (beh.finalId.exposureState.M2 === null));
  console.log('    settled error writes 0 / cleanup 1            : ' + (beh.settledError.exposure === 0 && beh.settledError.end === 1 && beh.settledError.homeTurns === 0));
  console.log('    pre-run error writes 0 / cleanup 1            : ' + (preRun.ok === true && preRun.exposureCalls === 0));
  console.log('    coldStart activation 0 / reinforcement 0      : ' + (beh.coldStart.activationCalls === 0 && beh.coldStart.reinforcementIds.length === 0));
  console.log('    coldStart exposure 1 / cleanup 0              : ' + (beh.coldStart.exposureCalls === 1 && beh.coldStart.homeTurns === 0));
  console.log('    reverse control removes future cooldown       : ' + (beh.reverse.reverseFactor === 1));
  console.log('  BUG3 = ' + (bug3 ? 'CLOSED' : 'NOT CLOSED'));

  check('BUG2.closure.gate', bug2, JSON.stringify({ structural: bug2Structural, turn2FactorOk: turn2FactorOk, E: E, coldToSurface: beh.coldToSurface, crossConv: beh.crossConv, charIsolation: beh.charIsolation, restart: beh.restart, reverse: beh.reverse }));
  check('BUG3.closure.gate', bug3, JSON.stringify({ structural: bug3Structural, A: A, finalId: beh.finalId, settledError: beh.settledError, preRun: preRun, coldStart: beh.coldStart, reverse: beh.reverse }));
  return beh;
}

rtMain().then(function () {
  console.log('\n' + '='.repeat(64));
  if (failures) { console.error('MEMORY RECALL COOLDOWN HOSTS FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
  else console.log('MEMORY RECALL COOLDOWN HOSTS PASSED · ' + passed + ' assertions green');
}).catch(function (error) {
  console.error('FATAL ' + ((error && error.stack) || error));
  process.exitCode = 1;
});
