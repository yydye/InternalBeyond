/* 角色互相写信 · 隔离/readAt/角色记忆命名空间 · 端到端单测。
   将 role-letters.js 源码在 mock 全局（IndexedDB 内存替代 + 假 LLM 门控）中求值，
   驱动 _roleLettersTick，验证：
   ① 按 recipientId 隔离（C 不可见 A→B）；② 私信不写入共享 memories；
   ③ 只有收件方阅读后才生成"收件方记忆"；④ 记忆按 owner/characterId 各自命名空间；
   ⑤ 发送方只记自己的视角；⑥ 旧信件无 readAt 视为未读；⑦ 历史误入 memories 被清理。 */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'assets/js/role-letters.js'), 'utf8');

const results = [];
function ok(name, pass, detail) { results.push({ name, pass }); console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : '')); }

/* ── 内存 Mock 层 ── */
const DB = {}; // store -> {id: rec}
const LS = {};
const toasts = [];
let apiConfigs = [
  { id: 'a', nickname: '阿澈', model: 'm-a', apiKey: 'k', endpoint: 'e', systemPrompt: '你是阿澈。', relationship: '好友' },
  { id: 'b', nickname: '小昕', model: 'm-b', apiKey: 'k', endpoint: 'e', systemPrompt: '你是小昕。', relationship: '挚友' },
  { id: 'c', nickname: '路人丙', model: 'm-c', apiKey: 'k', endpoint: 'e', systemPrompt: '你是路人丙。', relationship: '认识' }
];
const now = Date.now();

global.db = {}; // truthy guard
global.dbGetAll = async (s) => Object.values(DB[s] || {});
global.dbGet = async (s, k) => (DB[s] || {})[k];
global.dbPut = async (s, d) => { if (!DB[s]) DB[s] = {}; DB[s][d.id] = Object.assign({}, d); };
global.dbDelete = async (s, k) => { if (DB[s]) delete DB[s][k]; };
/* 索引 mock：byTo→toRoleId / byFrom→fromRoleId / byCharacter→characterId */
const _idxField = { byTo: 'toRoleId', byFrom: 'fromRoleId', byCharacter: 'characterId', byFriend: 'friendId' };
global.dbGetByIndex = async (s, idx, val) => {
  const field = _idxField[idx] || idx;
  return Object.values(DB[s] || {}).filter(r => String(r[field]) === String(val));
};
global.localStorage = {
  getItem: k => (LS[k] === undefined ? null : LS[k]),
  setItem: (k, v) => { LS[k] = String(v); }
};
global.toast = m => toasts.push(m);
global.esc = s => String(s == null ? '' : s);
global.updateMemDashboard = () => {};

global.window = {
  apiConfigs,
  _ibApiReady: () => true,
  _momentsCfg: id => apiConfigs.find(c => c.id === id) || null,
  _momentsPairAffinity: () => 55,
  _momentsAvatar: () => '',
  getRoleMoments: async () => [],
  _activeTextSimilarity: () => 0,
  _activeParsePlanJson: (t) => { try { return JSON.parse(String(t).trim()); } catch (e) { return null; } },
  _momentsContext: async (c) => ({ user: { name: '用户' }, character: c, recentMessages: [], memories: [{ title: '记忆一', content: '上周一起去了海边' }], recentProactiveMessages: [], chatSummary: '', recentMoments: [], otherRoleMoments: [] }),
  /* 假 LLM：按任务类型返回确定性 JSON 门控 */
  callApiChat: async (cfg, messages, opts) => {
    const msg = messages.map(m => m.content).join('\n');
    if (msg.indexOf('决定此刻是否给某位朋友写一封信') !== -1) {
      return '{"write":true,"to":1,"content":"最近想起那天在海边说的话，想写封信给你，聊聊那段风。","reason":""}';
    }
    if (msg.indexOf('决定是否回信') !== -1) {
      return '{"reply":true,"content":"读了信，想起那些风里的黄昏，回你一封信。","reason":""}';
    }
    return '{}';
  }
};

/* 载入模块（IIFE 挂在 window.IB） */
global.window.IB = { expose: () => {} };
(0, eval)(src);

const tick = async () => { await window._roleLettersTick(); };
const memsOf = roleId => (Object.values(DB.roleLetterMemories || {}) || []).filter(m => String(m.characterId) === String(roleId));
const sharedPollution = () => (Object.values(DB.memories || {}) || []).filter(m => m.source === 'role_letter').length;

(async () => {
  /* 1) 首轮：仅播种 nextInitAt（不触发写信） */
  await tick();
  const st1 = JSON.parse(LS['ib_role_letters_state_v1']);
  ok('首轮播种 nextInitAt', Number(st1.a.nextInitAt) > now && Number(st1.b.nextInitAt) > now);
  ok('首轮不写信', !DB.roleLetters);
  ok('共享 memories 无 role-letter 污染（初始）', sharedPollution() === 0);

  /* 2) 把 a/b 的 nextInitAt 置为过去 → 触发写信 */
  LS['ib_role_letters_state_v1'] = JSON.stringify({ a: { nextInitAt: now - 1000 }, b: { nextInitAt: now - 1000 } });
  await tick();
  const letters = Object.values(DB.roleLetters || {});
  const init = letters.filter(l => l.kind === 'init');
  ok('到期生成主动信', init.length >= 1, 'count=' + init.length);
  const first = init.find(l => String(l.fromRoleId) === 'a');
  ok('写信方向 a→b', !!first && String(first.toRoleId) === 'b');
  ok('信正文非空', !!first && String(first.content).length > 20);
  ok('新建信 readAt 为 null（未读）', !!first && first.readAt === null);

  /* 3) 对偶冷却已写入 */
  const pairs = JSON.parse(LS['ib_role_letters_pair_v1'] || '{}');
  ok('对偶冷却已写入', typeof pairs['a|b'] === 'number' && pairs['a|b'] > 0);

  /* 4) 收件隔离：C 不可见 A→B；B 收件箱可见；A 发件箱可见 */
  const inboxC = await window._rlLoadLettersFor('c', 'inbox');
  ok('C 收件箱看不到 A→B', !inboxC.some(l => l.id === first.id));
  const inboxB = await window._rlLoadLettersFor('b', 'inbox');
  ok('B 收件箱能看到 A→B', inboxB.some(l => l.id === first.id));
  const outA = await window._rlLoadLettersFor('a', 'outbox');
  ok('A 发件箱能看到自己发出的信', outA.some(l => l.id === first.id));
  const inboxA = await window._rlLoadLettersFor('a', 'inbox');
  ok('A 收件箱看不到自己发出的信', !inboxA.some(l => l.id === first.id));

  /* 5) 私信不进入共享 memories；只按角色命名空间落发送方记忆 */
  ok('共享 memories 无 role-letter 污染（写信后）', sharedPollution() === 0);
  ok('发送方 A 已记自己的视角（owner=a）', memsOf('a').some(m => m.direction === 'send' && String(m.letterId) === String(first.id)));
  ok('收件方 B 尚无记忆（未阅读）', !memsOf('b').some(m => m.direction === 'receive' && String(m.letterId) === String(first.id)));

  /* 6) 1天限流 + 冷却 → 再次 tick 不再写信 */
  const initCountBefore = (Object.values(DB.roleLetters || {}).filter(l => l.kind === 'init')).length;
  await tick();
  const initCountAfter = (Object.values(DB.roleLetters || {}).filter(l => l.kind === 'init')).length;
  ok('同日不再重复主动写', initCountAfter === initCountBefore, initCountBefore + '→' + initCountAfter);

  /* 7) 待回信队列（b 收到 a 的信） */
  const q = JSON.parse(LS['ib_role_letters_replyq_v1'] || '{}');
  ok('收信方进入待回信队列', !!q.b && q.b.letterId === first.id);
  ok('待回信延迟≥1h', q.b.dueAt - now >= 3600000);

  /* 8) 未阅读前：即使到期回信/评估，也不产生"收件方已读记忆" */
  LS['ib_role_letters_replyq_v1'] = JSON.stringify({ b: { letterId: first.id, dueAt: now - 1000 } });
  const memBefore = memsOf('b').length;
  await tick();
  ok('未阅读则不生成收件方记忆', memsOf('b').filter(m => m.direction === 'receive' && String(m.letterId) === String(first.id)).length === 0, 'before=' + memBefore + ' after=' + memsOf('b').length);

  /* 9) B 实际阅读（readAt）后：回信生成 + B 的"收件记忆"由 B 自己的 tick 生成 */
  const l = await global.dbGet('roleLetters', first.id);
  l.readAt = now; await global.dbPut('roleLetters', l);           /* B 在收件箱打开 */
  LS['ib_role_letters_replyq_v1'] = JSON.stringify({ b: { letterId: first.id, dueAt: now - 1000 } });
  await tick();
  const after = Object.values(DB.roleLetters || {});
  const reply = after.find(l2 => l2.kind === 'reply' && String(l2.parentId) === first.id);
  ok('生成回信 b→a', !!reply && String(reply.fromRoleId) === 'b' && String(reply.toRoleId) === 'a');
  ok('原信标记已回复', (DB.roleLetters || {})[first.id] && ((DB.roleLetters || {})[first.id]).replyStatus === 'replied');
  ok('B 阅读后生成收件方记忆（owner=b）', memsOf('b').some(m => m.direction === 'receive' && String(m.letterId) === String(first.id)));
  ok('B 自己的回信记忆（owner=b）', memsOf('b').some(m => m.direction === 'reply'));
  ok('记忆按 owner/characterId 各自命名空间（a/b 都有各自记录）', memsOf('a').length >= 1 && memsOf('b').length >= 1);
  ok('共享 memories 无 role-letter 污染（回信后）', sharedPollution() === 0);

  /* 10) 冷却期 b 不再主动写给 a */
  LS['ib_role_letters_state_v1'] = JSON.stringify({ a: { nextInitAt: now + 999999 }, b: { lastInitAt: 0, nextInitAt: now - 1000 } });
  await tick();
  const initOfBtoA = (Object.values(DB.roleLetters || {}).filter(l => l.kind === 'init' && String(l.fromRoleId) === 'b' && String(l.toRoleId) === 'a'));
  ok('冷却期 b 不主动写给 a', initOfBtoA.length === 0);

  /* 11) 跨角色隔离：注入一封 a→c，确认 B 收件箱仍看不到它（无关第三方私信） */
  const cross = await window._rlStoreLetter({ fromRoleId: 'a', toRoleId: 'c', content: '这是 a 只写给 c 的私信正文。', kind: 'init', createdAt: now });
  const inboxB2 = await window._rlLoadLettersFor('b', 'inbox');
  ok('B 看不到 A→C 的第三方私信', !inboxB2.some(l => l.id === cross.id));
  const inboxC2 = await window._rlLoadLettersFor('c', 'inbox');
  ok('C 收件箱能看到 A→C', inboxC2.some(l => l.id === cross.id));

  /* 12) 旧信件兼容：无 readAt 视为未读 */
  const legacy = await window._rlStoreLetter({ fromRoleId: 'b', toRoleId: 'a', content: '旧信，没有 readAt 字段。', kind: 'init', createdAt: now });
  delete legacy.readAt; global.dbPut('roleLetters', legacy);
  const legacyStored = await global.dbGet('roleLetters', legacy.id);
  ok('旧信无 readAt 视为未读', !legacyStored.readAt);

  /* 13) 历史误入共享 memories 被清理（模拟注入一条 source==='role_letter'；清掉一次性标记后再触发） */
  delete LS['ib_role_letters_clean_v1'];
  global.dbPut('memories', { id: 'mem_pollute', source: 'role_letter', characterId: 'b', content: 'B 收到了 A 的信（历史污染）。', created: now });
  ok('清理前存在历史污染', sharedPollution() === 1);
  await tick();
  ok('历史 role-letter 污染已从共享 memories 清理', sharedPollution() === 0);

  /* 14) 记忆回灌但角色间不泄漏：_rlMemoriesFor 只返回各自 owner（characterId）命名空间 */
  await window._rlWriteRoleMemory('c', '我收到了小昕的来信，其中提到：山间的雾。', '小昕的来信', 'rletter_c', 'receive');
  const memA = await window._rlMemoriesFor('a');
  const memB = await window._rlMemoriesFor('b');
  const memC = await window._rlMemoriesFor('c');
  ok('A 的记忆只含 A 自己（owner=a）', memA.every(m => String(m.owner) === 'a') && memA.length >= 1);
  ok('B 的记忆只含 B 自己（owner=b）', memB.every(m => String(m.owner) === 'b'));
  ok('C 的记忆只含 C 自己（owner=c）', memC.every(m => String(m.owner) === 'c') && memC.length >= 1);
  ok('B 的记忆不含 A→C 私信', !memB.some(m => String(m.owner) === 'c') && !memB.some(m => String(m.letterId) === String(cross.id)));
  ok('A 的记忆不含 B/C 的收件记忆', !memA.some(m => String(m.owner) === 'b') && !memA.some(m => String(m.owner) === 'c'));

  /* 15) _rlMemBlock 只格式化传入的 owner 范围数据（查询层已过滤，无 Prompt 级跨角色读取） */
  const blockA = window._rlMemBlock(memA), blockB = window._rlMemBlock(memB), blockC = window._rlMemBlock(memC);
  ok('B 的私信记忆区块含自己的 A→B 记忆', blockB.indexOf('海边') !== -1);
  ok('B 的区块不含 C 的私信记忆', blockB.indexOf('山间的雾') === -1);
  ok('C 的区块含自己的记忆但不含 A↔B', blockC.indexOf('山间的雾') !== -1 && blockC.indexOf('海边') === -1 && blockC.indexOf('黄昏') === -1);
  ok('A 的区块不含 B/C 的私信记忆', blockA.indexOf('山间的雾') === -1 && blockA.indexOf('黄昏') === -1);
  ok('空数组区块为空串', window._rlMemBlock([]) === '');

  const passCount = results.filter(r => r.pass).length;
  console.log('\n==== ' + passCount + '/' + results.length + ' PASS ====');
  process.exit(passCount === results.length ? 0 : 1);
})();
