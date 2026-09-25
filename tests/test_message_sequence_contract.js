'use strict';

/* Internal Beyond · P23 Phase 2A · Message Sequence Contract 测试
   （static 组：零依赖、零网络、零浏览器）
   运行：node tests/test_message_sequence_contract.js

   本阶段冻结的是**数据契约**：一次模型回合 → N 条**真正独立**的 canonical chatMessage。
   因此这里测的是"给定上层给出的一个 sequence，IB 能不能正确表示 / 持久化 / 重载 /
   撤回 / 导出 / 检索 / 重建上下文 / 保持兼容"，而不是任何拆句或节奏策略。

   覆盖用户给定的 A–X：
     A 单条 text · B text+text · C text+voice · D voice+text · E 3+ units · F 唯一 id
     G 同一回合身份 · H 确定性 sequenceIndex · I reload 顺序 · J 同 timestamp 顺序
     K 撤回一个 unit · L 撤回 voice unit · M legacy 兼容 · N legacy 单条路径不变
     O export/import · P search · Q context reconstruction · R provider wire 归一
     S secret 探针 · T malformed sequence · U 空 unit · V stale voice · W Mobile DTO
     X 无重复 memory/context 注入

   做法：契约与纯逻辑 require 真实模块；撤回走**真实生产函数体**（sliceFunction +
   桩 store，与 test_voice_message_lifecycle.js 同一套做法）；持久化/顺序走**真实
   Home Node chat store**（node:sqlite + 临时目录）；DOM 绑定的读取点用源码级断言。 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const VoiceCore = require(path.join(ROOT, 'assets', 'js', 'voice-message-core.js'));
const SeqCore = require(path.join(ROOT, 'assets', 'js', 'delivery-sequence-core.js'));
const ModelCore = require(path.join(ROOT, 'assets', 'js', 'ib-model-core.js'));
const MobileDto = require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'));
const DialogueCore = require(path.join(ROOT, 'assets', 'js', 'dialogue-core.js'));
const createChatStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
/* CRLF 安全的花括号配对提取器（源码是 CRLF）。 */
function sliceFunction(text, signature) {
  const at = text.indexOf(signature);
  if (at < 0) throw new Error('找不到 ' + signature);
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
  }
  throw new Error('花括号不配对: ' + signature);
}

const AUDIO = 'data:audio/wav;base64,' + Buffer.from('RIFF0000WAVEfmt-seq-payload').toString('base64');
const BRIDGE = '/tts/seq_lc.wav';
const TURN_SEED = 'msg_1700000000100_u';
const TURN = SeqCore.turnIdFor(TURN_SEED);
const TS = 1700000000100;
const CTX = { friendId: 'friend_1', timestamp: TS, model: 'provider-x', modelId: 'model-y', configId: 'friend_1', showThinking: true };

function textUnit(t) { return { kind: 'text', text: t }; }
function voiceUnit(t, extra) {
  return Object.assign({
    kind: 'voice', text: t, dataUrl: AUDIO, audioUrl: BRIDGE, mime: 'audio/wav', duration: 2.5,
    provenance: { source: 'voicebox', provider: 'voicebox', engine: 'qwen', voiceId: 'p1', voiceType: 'builtin', apiKey: 'sk-should-be-dropped-000000' }
  }, extra || {});
}
function seq(units, turnId) { return { turnId: turnId === undefined ? TURN : turnId, units: units }; }
function build(units, over) { return SeqCore.buildMessages(seq(units), Object.assign({}, CTX, over || {})); }
function orderUses(src) { return (src.match(/_ibOrderMessages\(/g) || []).length; }

/* ── A–H · 构造契约 ─────────────────────────────────────────────────── */
function construction() {
  /* A. 单条 text */
  {
    const ms = build([textUnit('不是，你等等')]);
    ok('A.single.count', ms.length === 1, ms.length);
    ok('A.single.content', ms[0].content === '不是，你等等', ms[0].content);
    ok('A.single.role', ms[0].role === 'assistant');
    ok('A.single.canonical', ChatCore.validateMessage(ms[0]).ok, JSON.stringify(ChatCore.validateMessage(ms[0]).errors));
    ok('A.single.idShape', ChatCore.isKnownMessageId(ms[0].id), ms[0].id);
    ok('A.single.noVoice', ms[0].voice === undefined);
    ok('A.single.indexZero', ms[0].metadata.sequenceIndex === 0);
  }
  /* B. text + text */
  {
    const ms = build([textUnit('不是，你等等'), textUnit('所以你不是普通用户？')]);
    ok('B.two.count', ms.length === 2, ms.length);
    ok('B.two.orderStable', ms[0].content === '不是，你等等' && ms[1].content === '所以你不是普通用户？');
    ok('B.two.indices', ms[0].metadata.sequenceIndex === 0 && ms[1].metadata.sequenceIndex === 1);
    ok('B.two.total', ms[0].metadata.sequenceTotal === 2 && ms[1].metadata.sequenceTotal === 2);
  }
  /* C. text + text + voice（用户给的例子） */
  {
    const ms = build([textUnit('不是，你等等'), textUnit('所以你不是普通用户？'), voiceUnit('你是 Cakumi 团队的人？')]);
    ok('C.mixed.count', ms.length === 3, ms.length);
    ok('C.mixed.voiceLast', !ms[0].voice && !ms[1].voice && !!ms[2].voice);
    ok('C.mixed.contentIsTranscript', ms[2].content === '你是 Cakumi 团队的人？' && ms[2].voice.transcript === ms[2].content);
    ok('C.mixed.voiceCanonical', VoiceCore.hasPlayable(ms[2].voice) && VoiceCore.isAiVoiceMessage(ms[2]) === true);
    ok('C.mixed.voiceProvenanceSanitized', ms[2].voice.provenance && ms[2].voice.provenance.source === 'voicebox'
      && !('apiKey' in ms[2].voice.provenance), JSON.stringify(ms[2].voice.provenance));
  }
  /* D. voice + text */
  {
    const ms = build([voiceUnit('先听我说'), textUnit('然后呢')]);
    ok('D.voiceFirst.count', ms.length === 2);
    ok('D.voiceFirst.voiceZero', !!ms[0].voice && ms[0].metadata.sequenceIndex === 0);
    ok('D.voiceFirst.textLast', ms[1].content === '然后呢' && !ms[1].voice);
  }
  /* E. 3+ units */
  {
    const ms = build([textUnit('一'), textUnit('二'), voiceUnit('三'), textUnit('四'), textUnit('五')]);
    ok('E.five.count', ms.length === 5, ms.length);
    ok('E.five.indicesSequential', ms.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2,3,4');
    ok('E.five.total', ms.every(m => m.metadata.sequenceTotal === 5));
  }
  /* F. 唯一 id */
  {
    const ms = build([textUnit('一'), textUnit('二'), voiceUnit('三')]);
    const ids = ms.map(m => m.id);
    ok('F.ids.uniquePerTurn', new Set(ids).size === ids.length, JSON.stringify(ids));
    const other = SeqCore.buildMessages(seq([textUnit('一'), textUnit('二'), voiceUnit('三')], SeqCore.turnIdFor('msg_1700000000100_u#2')), CTX);
    ok('F.ids.uniqueAcrossTurnsSameMs', other.every(m => ids.indexOf(m.id) < 0), JSON.stringify(other.map(m => m.id)));
  }
  /* G. 同一回合身份 */
  {
    const ms = build([textUnit('一'), textUnit('二'), voiceUnit('三')]);
    ok('G.turn.sameOnEveryUnit', ms.every(m => m.metadata.turnId === TURN), JSON.stringify(ms.map(m => m.metadata.turnId)));
    ok('G.turn.differsAcrossTurns', SeqCore.turnIdFor('a') !== SeqCore.turnIdFor('b'));
    ok('G.turn.deterministic', SeqCore.turnIdFor(TURN_SEED) === TURN);
    ok('G.turn.emptySeedIsEmpty', SeqCore.turnIdFor('') === '');
    ok('G.turn.uniformTimestamp', new Set(ms.map(m => m.timestamp)).size === 1, JSON.stringify(ms.map(m => m.timestamp)));
    ok('G.turn.noFakeOffset', ms.every(m => m.timestamp === TS));
  }
  /* H. 确定性 sequenceIndex（同输入逐字节同输出） */
  {
    const a = JSON.stringify(build([textUnit('一'), textUnit('二'), voiceUnit('三')]));
    const b = JSON.stringify(build([textUnit('一'), textUnit('二'), voiceUnit('三')]));
    ok('H.deterministic.byteIdentical', a === b);
    ok('H.deterministic.idIdentical', build([textUnit('一')])[0].id === build([textUnit('一')])[0].id);
    ok('H.indexFromOrder', build([textUnit('x'), textUnit('y')])[1].metadata.sequenceIndex === 1);
  }
  /* 预留种类：image 只登记不实现（planner 属后续阶段） */
  ok('KIND.imageReserved', SeqCore.RESERVED_KINDS.indexOf('image') >= 0 && SeqCore.SUPPORTED_KINDS.indexOf('image') < 0);
  {
    const v = SeqCore.validate(seq([textUnit('a'), { kind: 'image', url: 'x' }]));
    ok('KIND.imageRejectedDeterministically', v.ok === false && v.errors.join(',') === 'unsupported-kind:1:image', JSON.stringify(v.errors));
  }
  /* 纯模块：零 DOM / 零 fetch / 零存储 / 零时钟 */
  {
    const src = read('assets/js/delivery-sequence-core.js');
    /* 先去掉注释再探针：判据是"代码里没有 IO/时钟"，不是"注释里不许提到这些词"。 */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    ok('CORE.pureNoIO', !/\bindexedDB\b|\bdocument\b|\bfetch\s*\(|\blocalStorage\b|\bsetTimeout\b|\bDate\.now\s*\(/.test(code));
    ok('CORE.loadedBeforeConsumers', (() => {
      const html = read('InternalBeyond.html');
      const a = html.indexOf('assets/js/delivery-sequence-core.js');
      const b = html.indexOf('assets/js/chat-authority.js');
      return a > 0 && b > a;
    })());
  }
}

/* ── I/J · 顺序（same-timestamp + reload 稳定性）────────────────────── */
function ordering() {
  const ms = build([textUnit('A'), textUnit('B'), voiceUnit('C')]);
  const shuffled = [ms[2], ms[0], ms[1]];
  const ordered = SeqCore.orderMessages(shuffled);
  ok('I.reload.orderRestored', ordered.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2', JSON.stringify(ordered.map(m => m.id)));
  ok('I.reload.idempotent', JSON.stringify(SeqCore.orderMessages(ordered).map(m => m.id)) === JSON.stringify(ordered.map(m => m.id)));
  ok('I.reload.noMutation', shuffled[0] === ms[2] && shuffled.length === 3);
  ok('I.reload.sameElements', ordered.every(m => ms.indexOf(m) >= 0) && ordered.length === ms.length);
  ok('I.reload.stableAcrossRuns', JSON.stringify(SeqCore.orderMessages(ms).map(m => m.id)) === JSON.stringify(ordered.map(m => m.id)));
  {
    const many = [];
    for (let i = 0; i < 12; i++) many.push(textUnit('u' + i));
    const big = build(many);
    const byId = big.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    /* 存储层的自然顺序就是 id 升序（IndexedDB 按 key=id 返回）。因此 id 必须
       "越靠后的 unit 越大" —— 否则任何没调用 orderMessages 的读取点（跨阶段冻结的
       social.js、测试 harness、未来的消费者）都会拿到乱序。序号补零 + 熵只由 turnId
       决定，就是为了让这条成立。 */
    ok('I.reload.idOrderIsSeedOrder', byId.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2,3,4,5,6,7,8,9,10,11',
      JSON.stringify(byId.map(m => m.id)));
    ok('I.reload.idShapeKeepsPartSuffix', /^msg_\d+_\d+_0\d{2}$/.test(big[1].id), big[1].id);
    ok('I.reload.overTenUnitsIndexOrder',
      SeqCore.orderMessages(byId).map(m => m.metadata.sequenceIndex).join(',') === big.map((_, i) => i).join(','));
  }
  /* J. 同一 timestamp：不同回合不交错（回合是连续块） */
  {
    const t1 = build([textUnit('a1'), textUnit('a2'), textUnit('a3')]);
    const t2 = SeqCore.buildMessages(seq([textUnit('b1'), textUnit('b2')], SeqCore.turnIdFor('other-turn')), CTX);
    const mixed = [t1[0], t2[0], t1[1], t2[1], t1[2]];
    const labels = SeqCore.orderMessages(mixed).map(m => m.content[0]).join('');
    ok('J.sameTs.turnsAreContiguous', labels === 'aaabb' || labels === 'bbaaa', labels);
    ok('J.sameTs.legacyTieBreakByTimestampThenId', (() => {
      const legacy = [
        { id: 'msg_5_b', role: 'assistant', content: 'x', friendId: 'f', timestamp: 5 },
        { id: 'msg_5_a', role: 'assistant', content: 'y', friendId: 'f', timestamp: 5 },
        { id: 'msg_4_z', role: 'assistant', content: 'z', friendId: 'f', timestamp: 4 }
      ];
      return SeqCore.orderMessages(legacy).map(m => m.id).join(',') === 'msg_4_z,msg_5_a,msg_5_b';
    })());
    ok('J.sameTs.compareAgreesInsideTurn', SeqCore.compareMessages(t1[0], t1[2]) < 0 && SeqCore.compareMessages(t1[2], t1[0]) > 0);
  }
  /* 真实缺陷回归：工具续轮先落库（更早 timestamp），主回复后落库（更晚 timestamp）——
     只按 timestamp 排会把主回复放到续轮下面；回合身份 + orderMessages 修好它。 */
  {
    const turn = SeqCore.turnIdFor('msg_1700000000500_u');
    const contMsg = SeqCore.buildMessages({ turnId: turn, units: [textUnit('续轮回复')] }, { friendId: 'friend_1', timestamp: TS + 10 })[0];
    const mainMsg = SeqCore.buildMessages({ turnId: turn, units: [textUnit('主回复')] }, { friendId: 'friend_1', timestamp: TS + 900 })[0];
    contMsg.metadata.sequenceIndex = 1;
    mainMsg.metadata.sequenceIndex = 0;
    const legacySort = [mainMsg, contMsg].slice().sort((a, b) => a.timestamp - b.timestamp).map(m => m.content);
    const canonical = SeqCore.orderMessages([mainMsg, contMsg]).map(m => m.content);
    ok('J.toolRound.legacySortIsWrong', legacySort.join('|') === '续轮回复|主回复', legacySort.join('|'));
    ok('J.toolRound.canonicalSortFixesIt', canonical.join('|') === '主回复|续轮回复', canonical.join('|'));
  }
}

/* ── 真实持久化：Home Node chat store（node:sqlite + 临时目录）────────── */
function persistence() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-seq-'));
  const store = createChatStore({ dataDir: dir });
  store.open();
  const ms = build([textUnit('不是，你等等'), textUnit('所以你不是普通用户？'), voiceUnit('你是 Cakumi 团队的人？')]);
  const results = store.putMessages(ms);
  ok('P1.store.batchAccepted', results.ok === true && results.count === 3, JSON.stringify(results).slice(0, 200));
  const page = store.listMessages({ friendId: 'friend_1' });
  ok('P2.store.readBack', page.ok === true && page.messages.length === 3, page.messages && page.messages.length);
  ok('P2.store.order', page.messages.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2', JSON.stringify(page.messages.map(m => m.metadata.sequenceIndex)));
  ok('P2.store.turnIdPreserved', page.messages.every(m => m.metadata.turnId === TURN));
  ok('P2.store.voicePreserved', page.messages[2] && VoiceCore.hasPlayable(page.messages[2].voice) && page.messages[2].voice.transcript === page.messages[2].content);
  /* 幂等：同一个 sequence 再写一次不产生第二份 */
  const again = store.putMessages(build([textUnit('不是，你等等'), textUnit('所以你不是普通用户？'), voiceUnit('你是 Cakumi 团队的人？')]));
  ok('P3.store.replayIdempotent', again.ok === true && again.summary.skipped === 3, JSON.stringify(again.summary));
  ok('P3.store.stillThree', store.listMessages({ friendId: 'friend_1' }).messages.length === 3);
  store.close();
  const store2 = createChatStore({ dataDir: dir });
  store2.open();
  const page2 = store2.listMessages({ friendId: 'friend_1' });
  ok('P4.store.survivesRestart', page2.messages.length === 3
    && page2.messages.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2'
    && page2.messages.every(m => m.metadata.turnId === TURN));
  store2.close();
}

/* ── K/L · 撤回（真实生产函数体）────────────────────────────────────── */
async function withdraw() {
  const src = read('assets/js/communication.js');
  const fnSrc = sliceFunction(src, 'async function _chatWithdrawMsg(');
  const ms = build([textUnit('A'), textUnit('B'), voiceUnit('C')]);
  const store = new Map(ms.map(m => [m.id, JSON.parse(JSON.stringify(m))]));
  const writes = [];
  const fn = new Function(
    'dbGet', 'dbPut', 'document', '_chatCfgById', 'window', 'activeFriendId', 'appendChatBubble',
    'return (' + fnSrc + ')'
  )(
    async (s, k) => (store.get(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
    async (s, d) => { store.set(d.id, JSON.parse(JSON.stringify(d))); writes.push(d.id) },
    { querySelectorAll: () => ({ forEach: () => {} }) },
    () => ({ nickname: 'X' }),
    { IBVoiceMessage: VoiceCore },
    null,
    () => {}
  );
  /* K. 撤回一个 text unit：只影响该条 */
  const okK = await fn(ms[1].id);
  const b = store.get(ms[1].id), a = store.get(ms[0].id), c = store.get(ms[2].id);
  ok('K.unit.withdrawn', okK === true && b.withdrawn === true && /撤回了一条消息/.test(b.content), b.content);
  ok('K.unit.siblingsUntouched', a.content === 'A' && !a.withdrawn && c.content === 'C' && !c.withdrawn);
  ok('K.unit.turnIdentityKept', b.metadata.turnId === TURN && b.metadata.sequenceIndex === 1 && b.metadata.sequenceTotal === 3);
  ok('K.unit.onlyOneWrite', writes.length === 1, JSON.stringify(writes));
  /* L. 撤回 voice unit：voice（音频 + 文字稿 + provenance）一起消失 */
  const okL = await fn(ms[2].id);
  const c2 = store.get(ms[2].id);
  ok('L.voice.withdrawn', okL === true && c2.withdrawn === true);
  ok('L.voice.voiceGone', !('voice' in c2), JSON.stringify(Object.keys(c2.voice || {})));
  ok('L.voice.audioGone', JSON.stringify(c2).indexOf('data:audio') < 0 && JSON.stringify(c2).indexOf('/tts/') < 0);
  ok('L.voice.transcriptGone', JSON.stringify(c2).indexOf('你是 Cakumi 团队的人？') < 0);
  ok('L.voice.provenanceGone', JSON.stringify(c2).indexOf('voicebox') < 0);
  ok('L.voice.siblingsStillThere', store.get(ms[0].id).content === 'A' && store.get(ms[1].id).withdrawn === true);
  ok('L.voice.secretFree', VoiceCore.findSecret(JSON.parse(JSON.stringify([...store.values()]))) === '');
}

/* ── M/N · legacy 兼容 ──────────────────────────────────────────────── */
function legacy() {
  const old = { id: 'msg_1700000000000_9', role: 'assistant', content: 'hello', friendId: 'friend_1', timestamp: 1700000000000 };
  ok('M.legacy.validates', ChatCore.validateMessage(old).ok === true);
  ok('M.legacy.noSequenceKeys', SeqCore.turnIdOf(old) === '' && SeqCore.sequenceIndexOf(old) === 0);
  ok('M.legacy.notSequenceMember', SeqCore.isSequenceMember(old, [old]) === false);
  ok('M.legacy.orderKeepsIt', JSON.stringify(SeqCore.orderMessages([old]).map(m => m.id)) === JSON.stringify([old.id]));
  ok('M.legacy.payloadRoundTrip', JSON.stringify(ChatCore.canonicalize(old).message) === JSON.stringify(old));
  ok('M.legacy.canonicalizeReportsNoNewField', ChatCore.canonicalize(old).dropped.length === 0);

  /* N. 单条路径不变：回合身份只在"确实交付了多条"时写入 */
  const comm = read('assets/js/communication.js');
  ok('N.single.streamWriteUnchanged', comm.indexOf("await dbPut('chatMessages',aiMsg);") >= 0);
  ok('N.single.turnIdOnlyWhenContinuation', /if\(_wsCont&&_turn&&_turn\.turnId\)\{aiMsg\.metadata\.turnId=/.test(comm));
  ok('N.single.turnIdOnlyWhenContinuationNonStream', /if\(_wsContN&&_turn&&_turn\.turnId\)\{aiMsg\.metadata\.turnId=/.test(comm));
  ok('N.single.turnScopeStampsIdFromUserMessage', /_seqCore\.turnIdFor\(userMsg\.id\)/.test(comm));
  ok('N.single.legacyAiMsgShapeKept', /const aiMsg=\{id:'msg_'\+Date\.now\(\)\+'_'\+Math\.floor\(Math\.random\(\)\*100000\),role:'assistant'/.test(comm));
  ok('N.single.legacyResultShapeKept', /_sendResult=\{ok:true,replyText:replyText,messageId:aiMsg\.id,userMessageId:userMsg\.id\}/.test(comm));
  ok('N.single.emptySequenceProducesNothing', SeqCore.buildMessages({ turnId: TURN, units: [] }, CTX).length === 0);
  ok('N.single.missingTimestampProducesNothing', SeqCore.buildMessages(seq([textUnit('a')]), { friendId: 'f' }).length === 0);
  ok('N.single.missingFriendIdProducesNothing', SeqCore.buildMessages(seq([textUnit('a')]), { timestamp: TS }).length === 0);
  ok('N.single.missingTurnIdProducesNothing', SeqCore.buildMessages({ units: [textUnit('a')] }, CTX).length === 0);
}

/* ── O · export / import ────────────────────────────────────────────── */
function exportImport() {
  const ms = build([textUnit('A'), voiceUnit('C')]);
  const coreSrc = read('assets/js/core.js');
  ok('O.export.wholeRecordCopied', coreSrc.indexOf('delete c.upstreamRaw;delete c.thinkingSources') >= 0);
  ok('O.export.importIsPlainPut', /for\(const m of data\.chatMessages\)await dbPut\('chatMessages',m\)/.test(coreSrc));
  const pack = JSON.parse(JSON.stringify({ version: 9, chatMessages: ms }));
  ok('O.roundTrip.idsStable', pack.chatMessages.map(m => m.id).join(',') === ms.map(m => m.id).join(','));
  ok('O.roundTrip.turnIdentity', pack.chatMessages.every(m => m.metadata.turnId === TURN)
    && pack.chatMessages.map(m => m.metadata.sequenceIndex).join(',') === '0,1');
  ok('O.roundTrip.voiceRecognizable', VoiceCore.hasPlayable(pack.chatMessages[1].voice) && VoiceCore.isAiVoiceMessage(pack.chatMessages[1]) === true);
  ok('O.roundTrip.noParentRow', pack.chatMessages.length === 2);
  ok('O.legacyExportStillImports', (() => {
    const old = { id: 'msg_1_9', role: 'assistant', content: 'hello', friendId: 'f', timestamp: 1 };
    const back = JSON.parse(JSON.stringify({ chatMessages: [old] })).chatMessages[0];
    return ChatCore.validateMessage(back).ok === true && SeqCore.turnIdOf(back) === '';
  })());
  ok('O.textExport.usesCanonicalOrder', /const msgs=_ibOrderMessages\(await dbGetAll\('chatMessages'\)\)/.test(read('assets/js/communication.js')));
}

/* ── P · search ─────────────────────────────────────────────────────── */
function search() {
  const ms = build([textUnit('不是，你等等'), textUnit('所以你不是普通用户？'), voiceUnit('你是 Cakumi 团队的人？')]);
  const hit = q => ms.filter(m => String(m.content || '').toLowerCase().includes(String(q).toLowerCase()));
  ok('P.search.hitsExactlyOneUnit', hit('普通用户').length === 1 && hit('普通用户')[0].metadata.sequenceIndex === 1);
  ok('P.search.voiceTranscriptSearchable', hit('Cakumi').length === 1 && hit('Cakumi')[0].metadata.sequenceIndex === 2);
  ok('P.search.noAggregateRow', ms.length === 3 && ms.every(m => typeof m.content === 'string' && !Array.isArray(m.units)));
  ok('P.search.communicationReadsUseCanonicalOrder', orderUses(read('assets/js/communication.js')) >= 7,
    orderUses(read('assets/js/communication.js')));
  ok('P.search.memoryReadsUseCanonicalOrder', (read('assets/js/memory.js').match(/_ibOrderMsgs\(/g) || []).length >= 5);
}

/* ── Q/R · 上下文重建与 provider wire 归一 ───────────────────────────── */
function contextAndWire() {
  const ms = build([textUnit('不是，你等等'), textUnit('所以你不是普通用户？'), voiceUnit('你是 Cakumi 团队的人？')]);
  const history = [{ role: 'user', content: '你是谁？', id: 'msg_1700000000100_u', timestamp: TS }].concat(ms);
  const mapped = history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
  ok('Q.context.oneRowPerUnit', mapped.length === 4 && mapped[1].content === '不是，你等等' && mapped[3].content === '你是 Cakumi 团队的人？');
  ok('Q.context.noStringifiedObject', mapped.every(x => x.content.indexOf('[object Object]') < 0));
  /* 三个 unit 进对话证据 ⇒ 三行角色行（绝不再合成一行"整回合"） */
  const evidence = DialogueCore.lines({ history: ms, userMessage: '你是谁？', currentId: 'msg_1700000000100_u' });
  ok('Q.context.dialogueEvidencePerUnit', evidence.length === 4 && evidence.filter(l => l.indexOf(DialogueCore.ROLE_LABEL) === 0).length === 3, JSON.stringify(evidence));
  ok('Q.context.noParentLine', evidence.filter(l => l.indexOf('不是，你等等') >= 0).length === 1);

  const gem = ModelCore.buildRequestBody({ provider: 'gemini', model: 'gemini-2.0-flash' }, { system: 's', messages: mapped }, { maxTokens: 64 });
  const gemRoles = gem.contents.map(c => c.role);
  ok('R.gemini.alternatingOnly', gemRoles.every((r, i) => i === 0 || r !== gemRoles[i - 1]), JSON.stringify(gemRoles));
  ok('R.gemini.textPreserved', JSON.stringify(gem.contents).indexOf('不是，你等等') >= 0 && JSON.stringify(gem.contents).indexOf('你是 Cakumi 团队的人？') >= 0);
  ok('R.gemini.roleCount', gemRoles.join(',') === 'user,model', JSON.stringify(gemRoles));
  const oai = ModelCore.buildRequestBody({ provider: 'deepseek', model: 'deepseek-v4-flash' }, { system: 's', messages: mapped }, { maxTokens: 64 });
  ok('R.openai.untouched', oai.messages.length === 5, oai.messages.length);
  const ant = ModelCore.buildRequestBody({ provider: 'anthropic', model: 'claude-x' }, { system: 's', messages: mapped }, { maxTokens: 64 });
  ok('R.anthropic.untouched', ant.messages.length === 4, ant.messages.length);
  const before = JSON.stringify(mapped);
  ModelCore.normalizeWireRoles(mapped, 'gemini');
  ok('R.normalize.noMutation', JSON.stringify(mapped) === before);
  ok('R.normalize.protocolRowsSplit', ModelCore.normalizeWireRoles(
    [{ role: 'assistant', content: 'x', tool_calls: [{ id: '1' }] }, { role: 'assistant', content: 'y' }], 'gemini').length === 2);
  ok('R.normalize.arrayPartsJoined', (() => {
    const out = ModelCore.normalizeWireRoles([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: [{ type: 'text', text: 'b' }] }
    ], 'gemini');
    return out.length === 1 && Array.isArray(out[0].content) && out[0].content.length === 2;
  })());
  const comm = read('assets/js/communication.js');
  ok('R.desktop.delegatesToCore', (comm.match(/_ibWireMessages\(/g) || []).length >= 3
    && /core\.normalizeWireRoles\(list,format\)/.test(comm));
  /* 桌面侧不得出现**第二份 history→wire 合并规则**：合并只允许由 IBModelCore 提供。
     （群聊既有的 collapseSameRole 作用在"已映射的 wire 行"上、与 provider 无关，
       属于 P23 2A 之前就存在的形状，本阶段不动它 —— 见阶段文档 §17/§18。） */
  ok('R.desktop.noSecondMergeRule', !/function\s+normalizeWireRoles/.test(comm)
    && /_ibWireMessages\(_msgs\.filter\(m=>m\.role!=='system'\),'gemini'\)/.test(comm));
}

/* ── S/T/U/V · 安全与边界 ───────────────────────────────────────────── */
function boundaries() {
  /* S. secret 探针：整批拒绝（fail closed） */
  {
    const bad = SeqCore.validate(seq([textUnit('a'), { kind: 'text', text: 'b', apiKey: 'x' }]));
    ok('S.secret.unitRejected', bad.ok === false && bad.errors.join(',').indexOf('secret-in-unit:1') >= 0, JSON.stringify(bad.errors));
    ok('S.secret.noMessages', SeqCore.buildMessages(seq([textUnit('a'), { kind: 'text', text: 'b', apiKey: 'x' }]), CTX).length === 0);
    const top = SeqCore.validate({ turnId: TURN, units: [textUnit('a')], authorization: 'Bearer abcdefghijklmn' });
    ok('S.secret.metadataRejected', top.ok === false && top.errors.indexOf('secret-in-metadata') >= 0, JSON.stringify(top.errors));
    /* provenance 走 Phase 1 的 canonical 清洗（丢秘密键），而不是拒绝整批 ——
       它的清洗语义是既有的、有测试的；清洗后的产物仍要过反向探针。 */
    const voiceSecret = SeqCore.validate(seq([voiceUnit('a', { provenance: { source: 'v', token: 'abc' } })]));
    ok('S.secret.voiceProvenanceSanitizedNotRejected',
      voiceSecret.ok === true && !('token' in (voiceSecret.units[0].voice.provenance || {})),
      JSON.stringify(voiceSecret.errors) + ' ' + JSON.stringify(voiceSecret.units[0] && voiceSecret.units[0].voice));
    ok('S.secret.voiceOutputClean', VoiceCore.findSecret(build([voiceUnit('a')])) === '');
    const clean = build([textUnit('a'), voiceUnit('b')]);
    ok('S.secret.cleanOutput', VoiceCore.findSecret(clean) === '', VoiceCore.findSecret(clean));
  }
  /* T. malformed sequence */
  {
    ok('T.malformed.notObject', SeqCore.validate(null).errors.join(',') === 'not-an-object');
    ok('T.malformed.unitsMissing', SeqCore.validate({ turnId: TURN }).errors.indexOf('missing-units') >= 0);
    ok('T.malformed.unitsNotArray', SeqCore.validate({ turnId: TURN, units: 'x' }).errors.indexOf('no-units-array') >= 0);
    ok('T.malformed.unitNotObject', SeqCore.validate(seq(['x'])).errors.indexOf('unit-not-object:0') >= 0);
    ok('T.malformed.kindMissing', SeqCore.validate(seq([{ text: 'a' }])).errors.indexOf('missing-kind:0') >= 0);
    ok('T.malformed.missingTurnId', SeqCore.validate({ units: [textUnit('a')] }).errors.indexOf('missing-turnId') >= 0);
    ok('T.malformed.tooManyUnits', SeqCore.validate(seq(new Array(61).fill(null).map((_, i) => textUnit('u' + i)))).errors.indexOf('too-many-units') >= 0);
    ok('T.malformed.neverThrows', (() => {
      try { SeqCore.buildMessages(undefined, CTX); SeqCore.buildMessages({ turnId: TURN, units: [{}] }, CTX); return true; } catch (e) { return false; }
    })());
    ok('T.malformed.noPartialWrite', SeqCore.buildMessages(seq([textUnit('a'), { text: 'b' }]), CTX).length === 0);
  }
  /* U. 空 unit：被丢弃并报告，其余照常产出 */
  {
    const v = SeqCore.validate(seq([textUnit('a'), { kind: 'text', text: '   ' }, voiceUnit('c')]));
    ok('U.empty.reported', v.ok === true && v.dropped.length === 1 && v.dropped[0].reason === 'empty-text' && v.dropped[0].index === 1, JSON.stringify(v.dropped));
    const ms = build([textUnit('a'), { kind: 'text', text: '   ' }, voiceUnit('c')]);
    ok('U.empty.noEmptyMessage', ms.length === 2 && ms.every(m => m.content.trim().length > 0));
    ok('U.empty.indicesContiguous', ms.map(m => m.metadata.sequenceIndex).join(',') === '0,1');
    ok('U.empty.totalCountsReal', ms.every(m => m.metadata.sequenceTotal === 2));
    const noSrc = SeqCore.validate(seq([{ kind: 'voice', text: 'a' }]));
    ok('U.empty.unplayableVoiceRejected', noSrc.ok === false && noSrc.errors.join(',').indexOf('unplayable-voice:0') >= 0, JSON.stringify(noSrc.errors));
  }
  /* V. stale voice：content 变了，音频不再代表这条消息 */
  {
    const ms = build([voiceUnit('今晚早点睡。')]);
    ok('V.stale.fresh', VoiceCore.isStale(ms[0]) === false && VoiceCore.isAiVoiceMessage(ms[0]) === true);
    ms[0].content = '今晚早点睡。记得关窗。';
    ok('V.stale.afterEdit', VoiceCore.isStale(ms[0]) === true && VoiceCore.isAiVoiceMessage(ms[0]) === false);
    ok('V.stale.renderDecisionSourceLevel', /_ibAiVoicePayload\(m\)/.test(read('assets/js/communication.js')));
  }
}

/* ── W · Mobile DTO ─────────────────────────────────────────────────── */
function mobileDto() {
  const ms = build([textUnit('A'), voiceUnit('C')]);
  const dto = MobileDto.messageDto(ms[1], { conversationId: 'dm:friend_1', revision: 7 });
  ok('W.dto.turnIdentity', dto.metadata.turnId === TURN && dto.metadata.sequenceIndex === 1 && dto.metadata.sequenceTotal === 2, JSON.stringify(dto.metadata));
  ok('W.dto.voiceAudioUrl', dto.voice.audioUrl === BRIDGE, JSON.stringify(dto.voice));
  ok('W.dto.voiceProvenance', dto.voice.provenance && dto.voice.provenance.source === 'voicebox' && !('apiKey' in dto.voice.provenance));
  ok('W.dto.voicePlayable', dto.voice.playable === true);
  ok('W.dto.noInlineAudio', dto.voice.dataUrl === undefined && JSON.stringify(dto).indexOf('data:audio') < 0);
  ok('W.dto.contentPresent', dto.content === 'C' && dto.role === 'assistant');
  ok('W.dto.revision', dto.revision === 7);
  ok('W.dto.badSequenceIndexDropped', (() => {
    const bad = MobileDto.messageDto(Object.assign({}, ms[0], { metadata: { turnId: TURN, sequenceIndex: 'x' } }));
    return bad.metadata && bad.metadata.sequenceIndex === undefined && bad.metadata.turnId === TURN;
  })());
  ok('W.dto.foreignAudioUrlRejected', (() => {
    const evil = MobileDto.messageDto(Object.assign({}, ms[1], { voice: { audioUrl: 'http://evil.example/x.mp3', mime: 'audio/mpeg', transcript: 't' } }));
    return evil.voice.audioUrl === undefined && evil.voice.playable === false;
  })());
  ok('W.dto.noSecret', VoiceCore.findSecret(dto) === '', VoiceCore.findSecret(dto));
  ok('W.dto.inlineVoiceFlagged', (() => {
    const inline = MobileDto.messageDto(Object.assign({}, ms[1], { voice: VoiceCore.build({ dataUrl: AUDIO, mime: 'audio/wav', transcript: 'C', content: 'C' }) }));
    return inline.voice.playable === true && inline.voice.inline === true && inline.voice.audioUrl === undefined;
  })());
}

/* ── X · 无重复 memory / context 注入 ───────────────────────────────── */
/* ── AD · 生产适配器（真实函数体）：waifu 多段交付的构造入口 ─────────── */
function adapter() {
  const comm = read('assets/js/communication.js');
  const coreSrc = sliceFunction(comm, 'function _ibDeliveryCore(');
  const seqSrc = sliceFunction(comm, 'function _ibSequenceMessages(');
  const factory = new Function('window',
    coreSrc + '\n' + seqSrc + '\nreturn { core: _ibDeliveryCore, build: _ibSequenceMessages };');
  const api = factory({ IBDeliverySequence: SeqCore });
  ok('AD.core.resolvesToGlobal', api.core() === SeqCore);
  const ms = api.build(['不是，你等等', '所以你不是普通用户？'], {
    turnId: TURN, friendId: 'friend_1', threadId: 'th_1', timestamp: TS,
    model: 'provider-x', modelId: 'model-y', configId: 'friend_1',
    showThinking: true, extraMetadata: { waifu: true, activityId: undefined }
  });
  ok('AD.waifu.twoMessages', !!ms && ms.length === 2, ms && ms.length);
  ok('AD.waifu.contentOrder', ms[0].content === '不是，你等等' && ms[1].content === '所以你不是普通用户？');
  ok('AD.waifu.turnIdentity', ms.every(m => m.metadata.turnId === TURN)
    && ms.map(m => m.metadata.sequenceIndex).join(',') === '0,1', JSON.stringify(ms.map(m => m.metadata)));
  ok('AD.waifu.extraMetadataKept', ms.every(m => m.metadata.waifu === true) && ms.every(m => !('activityId' in m.metadata)));
  ok('AD.waifu.modelMetadataKept', ms.every(m => m.metadata.model === 'provider-x' && m.metadata.model_id === 'model-y' && m.metadata.config_id === 'friend_1'));
  ok('AD.waifu.sharedTimestamp', new Set(ms.map(m => m.timestamp)).size === 1);
  ok('AD.waifu.threadKept', ms.every(m => m.threadId === 'th_1'));
  ok('AD.waifu.canonical', ms.every(m => ChatCore.validateMessage(m).ok));
  /* 同一个 sequence 重放 ⇒ 逐字节相同（waifu 重放不会写第二份） */
  ok('AD.waifu.deterministic', JSON.stringify(api.build(['a', 'b'], { turnId: TURN, friendId: 'f', timestamp: TS }))
    === JSON.stringify(api.build(['a', 'b'], { turnId: TURN, friendId: 'f', timestamp: TS })));
  /* 核心缺席 ⇒ null（调用方退回单条行为，绝不手写第二份构造逻辑） */
  const noCore = factory({ });
  ok('AD.noCoreIsNull', noCore.build(['x'], { turnId: TURN, friendId: 'f', timestamp: TS }) === null);
  ok('AD.emptyTextsIsNull', api.build([], { turnId: TURN, friendId: 'f', timestamp: TS }) === null);
}

function noDuplication() {
  const ms = build([textUnit('A'), textUnit('B'), voiceUnit('C')]);
  ok('X.noDup.noParentRow', ms.length === 3 && ms.every(m => !m.units && !m.children && !m.segments));
  const seen = ms.map(m => m.content);
  ok('X.noDup.eachContentOnce', seen.length === 3 && new Set(seen).size === 3);
  const sample = SeqCore.orderMessages(ms).slice(-2);
  ok('X.noDup.memorySample', sample.length === 2 && sample[0].metadata.sequenceIndex === 1 && sample[1].metadata.sequenceIndex === 2);
  const lines = DialogueCore.lines({ history: ms.map(m => ({ role: m.role, content: m.content })) });
  ok('X.noDup.contextLines', lines.length === 3, JSON.stringify(lines));
  const comm = read('assets/js/communication.js');
  ok('X.noDup.noAggregateWrite', !/\.units\s*=/.test(comm));
  /* P23 2C/2D 之后，多段交付的构造入口有两个（都在 2A 契约之内）：
       · text 路径：_ibSequenceMessages（一次性构造整条序列）
       · voice 物化路径（2D）：_ibBuildUnitAt（按前缀构造，音频在 delivery time 才有）
     两者都必须经 delivery-sequence-core 的 buildMessages —— 断言这一点而不是某一行的字面形状。 */
  ok('X.noDup.waifuUsesSequenceCore', /_ibSequenceMessages\(/.test(comm)
    && /const _waifuMsgs=\(_waifuSegs&&!_mmHasVoice\)\?_ibSequenceMessages\(/.test(comm));
  ok('X.noDup.voicePathUsesContractBuilder', /function _ibBuildUnitAt\(queue,unit,index\)/.test(comm)
    && /core\.buildMessages\(\{turnId:String\(queue\.turnId\|\|''\),units:inputs\}/.test(comm));
  ok('X.noDup.toolRoundStampsTurnIdentity', /_cMsg\.metadata\.turnId=_turn\.turnId;_cMsg\.metadata\.sequenceIndex=round\+1/.test(comm));
}

async function main() {
  console.log('== Internal Beyond · P23 Phase 2A · Message Sequence Contract 测试 ==');
  construction();
  ordering();
  persistence();
  await withdraw();
  legacy();
  exportImport();
  search();
  contextAndWire();
  boundaries();
  mobileDto();
  adapter();
  noDuplication();
  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main();
