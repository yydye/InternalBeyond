'use strict';

/* Internal Beyond · P24-M1 · Group Turn Identity Foundation 测试
   （static 组：零依赖、零网络、零浏览器、零真实 provider）
   运行：node tests/test_group_turn_identity.js

   本阶段冻结的是**群聊的身份地基**（IDENTITY-ONLY），不是群聊行为：
     一次用户输入 → 一个 GroupTurn（groupTurnId）
        → 每个实际发言成员一个 MemberTurn（turnId / speakerId / groupOrder）
          → 每个成员自己的 P23 sequence（sequenceIndex）

   覆盖用户给定的 A–J：
     A groupTurnId 确定性（同一 user message ⇒ 同一个 id；不同 ⇒ 不同）
     B MemberTurn identity（同群回合下不同 speaker 的 turnId 必不相同；
       且与 P23 turnIdFor 逐字等值 —— 跨模块漂移守卫）
     C 一个 MemberTurn 产生多条 unit（群三键相同、sequenceIndex 0/1/2）
     D 多个成员（groupOrder 0/1、各自 turnId 独立、回合块不交错）
     E legacy 兼容（无 P24 三键的旧消息行为不变，且绝不回填/猜测）
     F 单聊隔离（单聊路径不得写 groupTurnId）
     G Home Node payload 往返（三键写读一致 + 重启后一致 + 重放幂等）
     H 秘密拒绝（复用唯一探针；身份里不得出现正文/凭据形态）
     I 不产生重复消息（无 parent 行 / 无 groupTurn 行 / 无隐藏 assistant 行）
     J P23 边界（不复制排序 / 队列 / 拆句 / 模态 / voice 契约）

   做法：真模块（chat-core / voice-message-core / delivery-sequence-core /
   group-runtime-core）+ 真 Home Node chat store（node:sqlite + 临时目录）；
   凡"行为不得改变"的断言一律做成**源码级结构断言**（去注释后检查），
   这样"没有引入第二套实现"是可判定的，而不是只写在注释里。 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ChatCore = require(path.join(ROOT, 'assets', 'js', 'chat-core.js'));
const SeqCore = require(path.join(ROOT, 'assets', 'js', 'delivery-sequence-core.js'));
const GroupCore = require(path.join(ROOT, 'assets', 'js', 'group-runtime-core.js'));
const createChatStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));

let passCount = 0;
let failCount = 0;
function ok(name, cond, detail) {
  if (cond) { passCount++; console.log('  PASS  ' + name); }
  else { failCount++; console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + String(detail).slice(0, 400) : '')); }
}
/* 去注释：所有"纯度 / 边界"断言都必须在**可执行代码**上成立，注释里出现
   "setTimeout" 之类的词不算违规（与 P23 的 purity 守卫同一口径）。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function sliceBetween(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) throw new Error('找不到起点: ' + from);
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error('找不到终点: ' + to);
  return src.slice(a, b);
}
function countOf(src, re) { return (src.match(re) || []).length; }

/* ── 固定输入（时间戳写死 ⇒ 断言逐字可复现）───────────────────────────── */
const USER_ID = 'msg_1700000000200_u';
const USER_ID_2 = 'msg_1700000000300_u';
const GROUP_ID = 'group_1700000000000';
const TS = 1700000000200;
const SPEAKER_A = 'friend_1700000000001_aa11bb';
const SPEAKER_B = 'friend_1700000000002_cc33dd';
const SPEAKER_C = 'friend_1700000000003_ee55ff';

const CTX = GroupCore.createIdentityContext({
  triggerUserMessageId: USER_ID, groupId: GROUP_ID, friendId: GROUP_ID, createdAt: TS
});
const MEMBER_A = GroupCore.createMemberIdentity(CTX, SPEAKER_A, 0);
const MEMBER_B = GroupCore.createMemberIdentity(CTX, SPEAKER_B, 1);
const MEMBER_C = GroupCore.createMemberIdentity(CTX, SPEAKER_C, 2);

/* 生产 adapter 的等价调用：P24 三键只经 extraMetadata 进入 canonical message。 */
function buildMember(member, texts, over) {
  const units = (texts || []).map(t => ({ kind: 'text', text: t }));
  return SeqCore.buildMessages({ turnId: member.turnId, units: units }, Object.assign({
    friendId: GROUP_ID, timestamp: TS, senderName: 'display-only',
    model: 'provider-x', modelId: 'model-y', configId: member.speakerId,
    extraMetadata: {
      groupTurnId: member.groupTurnId, speakerId: member.speakerId, groupOrder: member.groupOrder
    }
  }, over || {}));
}
function p24(m) {
  return (m && m.metadata) ? { g: m.metadata.groupTurnId, s: m.metadata.speakerId, o: m.metadata.groupOrder } : null;
}

/* ── A · groupTurnId 确定性 ─────────────────────────────────────────────── */
function determinism() {
  const a1 = GroupCore.groupTurnIdFor(USER_ID);
  const a2 = GroupCore.groupTurnIdFor(USER_ID);
  const b = GroupCore.groupTurnIdFor(USER_ID_2);
  ok('A.sameUserMessageSameGroupTurnId', a1 === a2 && !!a1, a1 + ' vs ' + a2);
  ok('A.differentUserMessageDifferentId', a1 !== b && !!b, a1 + ' vs ' + b);
  ok('A.shape', /^gturn_[a-z0-9]{1,32}$/.test(a1) && GroupCore.isGroupTurnId(a1), a1);
  ok('A.emptyTriggerIsEmptyId', GroupCore.groupTurnIdFor('') === '' && GroupCore.groupTurnIdFor(null) === '');
  ok('A.equalsContractFormula', a1 === ('gturn_' + ChatCore.stableToken(USER_ID)), a1);
  const ctxAgain = GroupCore.createIdentityContext({ triggerUserMessageId: USER_ID, groupId: GROUP_ID, createdAt: TS });
  ok('A.contextIsDeterministic', JSON.stringify(ctxAgain) === JSON.stringify(CTX));
  ok('A.contextValidates', GroupCore.validateIdentityContext(CTX).ok === true, JSON.stringify(GroupCore.validateIdentityContext(CTX).errors));
  ok('A.contextConversationIdFromChatCore', CTX.conversationId === ChatCore.conversationIdOf(GROUP_ID), CTX.conversationId);

  /* 身份不得来自时钟 / 随机 / 昵称 / 数组下标：可执行代码里零命中 */
  const code = stripComments(read('assets/js/group-runtime-core.js'));
  ok('A.noClockNoRandom', !/Date\.now/.test(code) && !/Math\.random/.test(code));
  /* P24-M2 更新：resolver 必须能**读** legacy 的 senderName 做唯一精确匹配，
     因此断言从"模块里不出现 senderName"收紧为"昵称绝不成为身份"：
       · 仍然零 nickname（模块不碰角色配置的显示字段）；
       · 没有任何 "speakerId = … senderName/nickname" 形式的赋值；
       · senderName 的用途只能是 legacy 回退（结果标记 legacy-exact-name）。 */
  ok('A.noDisplayNameAsIdentity', !/nickname/.test(code)
    && !/(speakerId|turnId|groupTurnId)\s*=\s*[^;\n]*(senderName|nickname)/.test(code)
    && /legacy-exact-name/.test(code));
  ok('A.noIndexAsIdentity', !/(speakerId|groupOrder|turnId)\s*=\s*[^;\n]*indexOf\(/.test(code));
  ok('A.reusesStableToken', /stableToken/.test(code));
}

/* ── B · MemberTurn identity ────────────────────────────────────────────── */
function memberIdentity() {
  ok('B.sameGroupTurn', MEMBER_A.groupTurnId === MEMBER_B.groupTurnId && MEMBER_A.groupTurnId === CTX.groupTurnId);
  ok('B.differentTurnIds', MEMBER_A.turnId !== MEMBER_B.turnId && !!MEMBER_A.turnId && !!MEMBER_B.turnId);
  ok('B.groupTurnIdIsNotTurnId', MEMBER_A.turnId !== CTX.groupTurnId);
  ok('B.turnIdShape', /^turn_[a-z0-9]{1,32}$/.test(MEMBER_A.turnId) && GroupCore.isMemberTurnId(MEMBER_A.turnId), MEMBER_A.turnId);
  /* 跨模块等值：P23 的 turnIdFor 与本模块必须给出逐字相同的 turnId（漂移守卫） */
  const seed = CTX.groupTurnId + ':' + SPEAKER_A + ':' + 0;
  const mine = GroupCore.memberTurnIdFor(CTX.groupTurnId, SPEAKER_A, 0);
  ok('B.equalsP23TurnIdFor', mine === SeqCore.turnIdFor(seed), mine + ' vs ' + SeqCore.turnIdFor(seed));
  ok('B.speakerIdIsApiConfigId', MEMBER_A.speakerId === SPEAKER_A && MEMBER_B.speakerId === SPEAKER_B);
  ok('B.groupOrderIsZeroBased', MEMBER_A.groupOrder === 0 && MEMBER_B.groupOrder === 1 && MEMBER_C.groupOrder === 2);
  ok('B.sameSpeakerDifferentOrderDiffers',
    GroupCore.memberTurnIdFor(CTX.groupTurnId, SPEAKER_A, 0) !== GroupCore.memberTurnIdFor(CTX.groupTurnId, SPEAKER_A, 1));
  ok('B.differentGroupTurnDiffers',
    GroupCore.memberTurnIdFor(GroupCore.groupTurnIdFor(USER_ID_2), SPEAKER_A, 0) !== MEMBER_A.turnId);
  ok('B.membersValidate', [MEMBER_A, MEMBER_B, MEMBER_C].every(m => GroupCore.validateMemberIdentity(m).ok === true));
  ok('B.badOrderRejected', GroupCore.validateMemberIdentity({ turnId: MEMBER_A.turnId, groupTurnId: CTX.groupTurnId, speakerId: SPEAKER_A, groupOrder: -1 })
    .errors.indexOf('bad-group-order') >= 0);
  ok('B.groupIdAsSpeakerRejected', GroupCore.validateMemberIdentity({ turnId: MEMBER_A.turnId, groupTurnId: CTX.groupTurnId, speakerId: GROUP_ID, groupOrder: 0 })
    .errors.indexOf('bad-speaker-id') >= 0);
  ok('B.turnIdMismatchRejected', GroupCore.validateMemberIdentity({ turnId: MEMBER_B.turnId, groupTurnId: CTX.groupTurnId, speakerId: SPEAKER_A, groupOrder: 0 })
    .errors.indexOf('turn-id-mismatch') >= 0);
  ok('B.turnIdEqualsGroupTurnIdRejected', GroupCore.validateMemberIdentity({ turnId: CTX.groupTurnId, groupTurnId: CTX.groupTurnId, speakerId: SPEAKER_A, groupOrder: 0 })
    .errors.indexOf('turn-id-equals-group-turn-id') >= 0);
}

/* ── C · 一个 MemberTurn 产生多条 unit ──────────────────────────────────── */
function multiUnit() {
  const ms = buildMember(MEMBER_A, ['第一段', '第二段', '第三段']);
  ok('C.threeMessages', ms.length === 3, ms.length);
  ok('C.sameGroupTurnId', ms.every(m => m.metadata.groupTurnId === CTX.groupTurnId));
  ok('C.sameSpeakerId', ms.every(m => m.metadata.speakerId === SPEAKER_A));
  ok('C.sameGroupOrder', ms.every(m => m.metadata.groupOrder === 0));
  ok('C.sequenceIndexContiguous', ms.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2', ms.map(m => m.metadata.sequenceIndex).join(','));
  ok('C.sharedTurnId', ms.every(m => m.metadata.turnId === MEMBER_A.turnId));
  ok('C.uniqueIds', new Set(ms.map(m => m.id)).size === 3);
  ok('C.canonicalMessages', ms.every(m => ChatCore.validateMessage(m).ok === true));
  const byId = ms.slice().sort((x, y) => (x.id < y.id ? -1 : (x.id > y.id ? 1 : 0)));
  ok('C.idOrderMatchesSequence', byId.map(m => m.metadata.sequenceIndex).join(',') === '0,1,2');
  ok('C.orderMessagesKeepsBlock', SeqCore.orderMessages(ms.slice().reverse()).map(m => m.content).join('|') === '第一段|第二段|第三段');
}

/* ── D · 多个成员 ───────────────────────────────────────────────────────── */
function multipleMembers() {
  const msA = buildMember(MEMBER_A, ['A1', 'A2'], { timestamp: TS });
  const msB = buildMember(MEMBER_B, ['B1'], { timestamp: TS + 5 });
  const msC = buildMember(MEMBER_C, ['C1'], { timestamp: TS + 10 });
  const all = msA.concat(msB, msC);
  ok('D.groupOrderSequence', all.map(m => m.metadata.groupOrder).join(',') === '0,0,1,2', all.map(m => m.metadata.groupOrder).join(','));
  ok('D.turnIdsIndependent', new Set(all.map(m => m.metadata.turnId)).size === 3);
  ok('D.groupTurnIdShared', new Set(all.map(m => m.metadata.groupTurnId)).size === 1);
  ok('D.speakerIdsDistinct', new Set(all.map(m => m.metadata.speakerId)).size === 3);
  const shuffled = [msB[0], msC[0], msA[1], msA[0]];
  const ordered = SeqCore.orderMessages(shuffled);
  ok('D.noInterleaving', ordered.map(m => m.content).join('|') === 'A1|A2|B1|C1', ordered.map(m => m.content).join('|'));
  ok('D.turnUnitCount', SeqCore.turnUnitCount(ordered, MEMBER_A.turnId) === 2);
  ok('D.turnUnitCountSingle', SeqCore.turnUnitCount(ordered, MEMBER_B.turnId) === 1);
  ok('D.sequenceIndexResetsPerMember', msA[0].metadata.sequenceIndex === 0 && msA[1].metadata.sequenceIndex === 1
    && msB[0].metadata.sequenceIndex === 0 && msC[0].metadata.sequenceIndex === 0);
}

/* ── E · legacy 兼容（绝不回填）────────────────────────────────────────── */
function legacy() {
  const old = {
    id: 'msg_1690000000000_12345', role: 'assistant', content: '旧群消息', friendId: GROUP_ID,
    senderName: 'OldName', timestamp: TS - 10000, metadata: { model: 'm', config_id: SPEAKER_A }
  };
  ok('E.legacyHasNoTurnId', SeqCore.turnIdOf(old) === '');
  ok('E.legacyNotGrouped', SeqCore.orderMessages([old]).length === 1 && p24(old).g === undefined);
  const fresh = buildMember(MEMBER_A, ['新消息']);
  const ordered = SeqCore.orderMessages(fresh.concat([old]));
  ok('E.legacyKeepsBaseOrder', ordered[0].id === old.id && ordered[1].id === fresh[0].id, ordered.map(m => m.id).join(','));
  const code = stripComments(read('assets/js/group-runtime-core.js'));
  ok('E.noBackfillApi', !/backfill|repair|guess|infer/i.test(code));
  /* P24-M2 更新：resolver 必须能**读** message.metadata.speakerId；
     不变量本身不变 —— 模块绝不改写消息、不读时钟：
       · 没有任何对消息字段的赋值（metadata / senderName / content）；
       · 仍然零 .timestamp。 */
  ok('E.moduleNeverTouchesMessages', !/\.timestamp/.test(code)
    && !/\.(metadata|senderName|content)\s*=[^=]/.test(code));
  ok('E.contextWithoutTriggerInvalid', GroupCore.validateIdentityContext(GroupCore.createIdentityContext({ groupId: GROUP_ID }))
    .errors.indexOf('missing-trigger-user-message-id') >= 0);
  ok('E.noStructuralCompensation', GroupCore.groupTurnIdFor('') === '' && GroupCore.memberTurnIdFor('', SPEAKER_A, 0) === '');
}

/* ── F · 单聊隔离 ───────────────────────────────────────────────────────── */
function singleChatIsolation() {
  const comm = read('assets/js/communication.js');
  const oneToOne = sliceBetween(comm, '/* ===== NORMAL 1-ON-1 CHAT ===== */', 'function appendChatBubble(');
  ok('F.oneToOneSliceIsReal', /extraMetadata:\{waifu:true/.test(oneToOne));
  ok('F.oneToOneHasNoGroupIdentity', !/groupTurnId/.test(oneToOne) && !/_ibGroup/.test(oneToOne));
  ok('F.p24ExtraMetadataExactlyOnce', countOf(comm, /extraMetadata:\{groupTurnId:/g) === 1);
  ok('F.identityContextExactlyOnce', countOf(comm, /_ibGroupIdentityContext\(\{/g) === 1);
  /* P24-M3.2 更新：群聊循环改为遍历 planner 的 plan.entries，groupOrder 取自 entry.order
     （planned order 权威；不再有 _gOrder 自增）。 */
  /* P24-M3.5.2A 更新：成员循环改为 queue 驱动（for(;;) + runtime/static 双分支），
     member identity 仍必须在该成员体内部、用 planner 的 entry.order 构造。 */
  /* P24-M3.5.2B 更新：循环头与成员体之间新增了 SILENT 决策 seam（仍位于 startedCount 之前），
     因此把窗口放宽到 2600 —— 不变量未变：identity 用 planner 的 entry.order、在成员体内构造。 */
  ok('F.memberIdentityInsideSpeakerLoop', /for\(;;\)\{[\s\S]{0,2600}_ibGroupMemberIdentity\(_gIdentity,cfg\.id,entry\.order\)/.test(comm));
  ok('F.continuationGate', /if\(_turn&&_turn\.groupTurnId\)\{_cMsg\.metadata\.groupTurnId=_turn\.groupTurnId;/.test(comm));
  ok('F.continuationKeepsP23Line', /if\(_turn&&_turn\.turnId\)\{_cMsg\.metadata\.turnId=_turn\.turnId;_cMsg\.metadata\.sequenceIndex=round\+1;\}/.test(comm));
  const groupBranch = sliceBetween(comm, 'if(isGroup){', '/* ===== NORMAL 1-ON-1 CHAT ===== */');
  ok('F.groupUsesSequenceAdapter', /_ibSequenceMessages\(\[reply\]/.test(groupBranch));
  ok('F.groupDoesNotCallContractDirectly', !/buildMessages\(/.test(groupBranch) && !/IBDeliverySequence/.test(groupBranch));
  ok('F.groupHasNoPostPatch', !/aiMsg\.metadata\.(groupTurnId|speakerId|groupOrder)\s*=/.test(comm));
}

/* ── G · Home Node payload 往返 ─────────────────────────────────────────── */
function homeNodeRoundTrip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-gturn-'));
  const store = createChatStore({ dataDir: dir });
  store.open();
  const ms = buildMember(MEMBER_A, ['A1', 'A2'], { timestamp: TS }).concat(buildMember(MEMBER_B, ['B1'], { timestamp: TS + 5 }));
  const res = store.putMessages(ms);
  ok('G.writeAccepted', res.ok === true && res.count === 3, JSON.stringify(res).slice(0, 200));
  const page = store.listMessages({ friendId: GROUP_ID });
  ok('G.readBack', page.ok === true && page.messages.length === 3, page.messages && page.messages.length);
  /* conversationId 是派生值（不回写进消息）：由 listMessages 的返回对象给出 */
  ok('G.conversationIdIsGroupScoped', page.conversationId === ('group:' + GROUP_ID), page.conversationId);
  ok('G.p24KeysRoundTrip', page.messages.map(m => JSON.stringify(p24(m))).join(',') === ms.map(m => JSON.stringify(p24(m))).join(','),
    JSON.stringify(page.messages.map(p24)));
  ok('G.turnIdentityRoundTrip', page.messages.map(m => m.metadata.turnId + '#' + m.metadata.sequenceIndex).join(',')
    === ms.map(m => m.metadata.turnId + '#' + m.metadata.sequenceIndex).join(','));
  const again = store.putMessages(ms.map(m => JSON.parse(JSON.stringify(m))));
  ok('G.replayIdempotent', again.ok === true && again.summary.skipped === 3, JSON.stringify(again.summary));
  store.close();
  const store2 = createChatStore({ dataDir: dir });
  store2.open();
  const page2 = store2.listMessages({ friendId: GROUP_ID });
  ok('G.survivesRestart', page2.messages.length === 3
    && page2.messages.map(m => JSON.stringify(p24(m))).join(',') === ms.map(m => JSON.stringify(p24(m))).join(','));
  store2.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
}

/* ── H · 秘密拒绝 ───────────────────────────────────────────────────────── */
function secretRejection() {
  const CRED = 'sk-abcdefgh12345678';
  ok('H.bearerInTriggerRejected', GroupCore.validateIdentityContext(Object.assign({}, CTX, { triggerUserMessageId: 'Bearer abcdefgh' }))
    .errors.indexOf('secret-in-identity') >= 0);
  ok('H.credentialGroupIdRejected', GroupCore.validateIdentityContext(Object.assign({}, CTX, { groupId: CRED }))
    .errors.indexOf('secret-in-identity') >= 0);
  ok('H.credentialSpeakerRejected', GroupCore.validateMemberIdentity(Object.assign({}, MEMBER_A, { speakerId: CRED }))
    .errors.indexOf('secret-in-identity') >= 0);
  const allowed = ['groupTurnId', 'groupId', 'friendId', 'threadId', 'conversationId', 'triggerUserMessageId', 'createdAt'];
  ok('H.contextKeysClosed', Object.keys(CTX).every(k => allowed.indexOf(k) >= 0), JSON.stringify(Object.keys(CTX)));
  ok('H.memberKeysClosed', JSON.stringify(Object.keys(MEMBER_A).sort()) === JSON.stringify(['groupOrder', 'groupTurnId', 'speakerId', 'turnId']));
  ok('H.noContentBearingFields', !('content' in CTX) && !('role' in CTX) && !('id' in CTX) && !('prompt' in CTX) && !('memory' in CTX));
  const code = stripComments(read('assets/js/group-runtime-core.js'));
  ok('H.reusesFindSecret', /findSecret/.test(code));
  ok('H.noLocalSecretPattern', !/apikey|api_key|sk-\[/i.test(code));
  const msg = buildMember(MEMBER_A, ['x'])[0];
  ok('H.scalarOnly', typeof msg.metadata.groupTurnId === 'string' && typeof msg.metadata.speakerId === 'string'
    && typeof msg.metadata.groupOrder === 'number');
  ok('H.sequenceSecretProbeStillActive',
    SeqCore.validate({ turnId: MEMBER_A.turnId, units: [{ kind: 'text', text: 'x' }], apiKey: CRED }).errors.indexOf('secret-in-metadata') >= 0);
}

/* ── I · 不产生重复消息 ─────────────────────────────────────────────────── */
function noDuplicateMessages() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-gturn-dup-'));
  const store = createChatStore({ dataDir: dir });
  store.open();
  const ms = buildMember(MEMBER_A, ['A1', 'A2', 'A3']);
  const res = store.putMessages(ms);
  ok('I.exactlyThreeRows', res.ok === true && store.countMessages() === 3, store.countMessages());
  ok('I.singleConversation', store.countConversations() === 1, store.countConversations());
  const changes = store.changesAfter(0);
  ok('I.identityCreatesNoEntity', changes.ok === true && changes.upserts.length === 3 && changes.deletes.length === 0,
    JSON.stringify({ upserts: changes.upserts && changes.upserts.length, deletes: changes.deletes && changes.deletes.length }));
  ok('I.noParentRow', ms.every(m => !('units' in m) && !('children' in m) && !('segments' in m)));
  ok('I.noHiddenAssistantRow', ms.every(m => m.role === 'assistant' && !!m.content));
  ok('I.identityIsNotAStoreRow', !('id' in CTX) && !('store' in CTX));
  const code = stripComments(read('assets/js/group-runtime-core.js'));
  ok('I.moduleHasNoStorage', !/dbPut|chatMessages|createObjectStore|indexedDB|sqlite|INSERT/i.test(code));
  store.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }
  const comm = read('assets/js/communication.js');
  ok('I.adapterHasNoAggregateWrite', !/\.units\s*=/.test(comm));
}

/* ── J · P23 边界 ──────────────────────────────────────────────────────── */
function p23Boundary() {
  const code = stripComments(read('assets/js/group-runtime-core.js'));
  const forbidden = [
    ['ordering', /orderMessages|compareMessages|\.sort\(/],
    ['queue', /enqueue|dequeue|DeliveryRuntime/],
    ['timing', /setTimeout|setInterval|requestAnimationFrame/],
    ['splitter', /split\(|MessagePresentation/],
    ['modality', /MultimodalPolicy|DeliveryPlanner/],
    ['voiceSchema', /VoiceMessage\.build|transcript|provenance|audioUrl|dataUrl/],
    ['messageIds', /'msg_'|messageIdFor/],
    ['transport', /fetch\(|XMLHttpRequest|new Audio/]
  ];
  forbidden.forEach(function (pair) {
    ok('J.no' + pair[0].charAt(0).toUpperCase() + pair[0].slice(1) + 'Duplication', !pair[1].test(code), pair[1]);
  });
  /* 群聊分支不得因为 M1 而打开 P23 的投递 / 模态路径（冻结行为） */
  const comm = read('assets/js/communication.js');
  const groupBranch = sliceBetween(comm, 'if(isGroup){', '/* ===== NORMAL 1-ON-1 CHAT ===== */');
  ok('J.groupStillDoesNotUseDeliveryRuntime', !/_ibStartDelivery\(/.test(groupBranch));
  ok('J.groupStillDoesNotUsePolicy', !/_ibMmResolve\(/.test(groupBranch));
  ok('J.groupStillWritesDirectly', /await dbPut\('chatMessages',aiMsg\)/.test(groupBranch));
  /* P24-M3.2 更新：参与权威已从 legacy filter 迁移到 planParticipation（唯一权威）——
     旧 filter 不再存在，循环遍历 plan.entries，entry→cfg 精确 id 命中。 */
  const groupBranchCode = stripComments(groupBranch);
  ok('J.participationAuthorityIsPlanner', /const memberCfgById=new Map\(memberCfgs/.test(groupBranchCode)
    && /planParticipation\(_gPlanInput\)/.test(groupBranchCode)
    /* P24-M3.5.2A 更新：循环头改为 queue 驱动（runtime/static 双分支），权威仍是 planner entries。 */
    && /let _gRtCursor=0;/.test(groupBranchCode)
    && /_gRtCursor>=plannedEntries\.length/.test(groupBranchCode)
    && !/speakingCfgs\s*=\s*memberCfgs\.filter/.test(groupBranchCode));
  ok('J.windowUntouched', /const gKeepCount=gss\.enabled/.test(groupBranch));
}

function main() {
  console.log('== Internal Beyond · P24-M1 · Group Turn Identity Foundation 测试 ==');
  determinism();
  memberIdentity();
  multiUnit();
  multipleMembers();
  legacy();
  singleChatIsolation();
  homeNodeRoundTrip();
  secretRejection();
  noDuplicateMessages();
  p23Boundary();
  console.log(failCount === 0 ? '\n全部通过 ✔  (' + passCount + ')'
    : '\n失败 ' + failCount + ' 项（通过 ' + passCount + '）');
  process.exitCode = failCount ? 1 : 0;
}

main();
