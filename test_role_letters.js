/* 角色互相写信 · 调度/频控/Memory/回信 端到端单测。
   将 role-letters.js 源码在 mock 全局（IndexedDB 内存替代 + 假 LLM 门控）中求值，
   驱动 _roleLettersTick，验证：首轮播种、到期写信、对偶冷却、1天限流、待回信、
   回信写入、双方 Memory。 */
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
  { id: 'b', nickname: '小昕', model: 'm-b', apiKey: 'k', endpoint: 'e', systemPrompt: '你是小昕。', relationship: '挚友' }
];
const now = Date.now();

global.db = {}; // truthy guard
global.dbGetAll = async (s) => Object.values(DB[s] || {});
global.dbGet = async (s, k) => (DB[s] || {})[k];
global.dbPut = async (s, d) => { if (!DB[s]) DB[s] = {}; DB[s][d.id] = Object.assign({}, d); };
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

(async () => {
  /* 1) 首轮：仅播种 nextInitAt（不触发写信） */
  await tick();
  const st1 = JSON.parse(LS['ib_role_letters_state_v1']);
  ok('首轮播种 nextInitAt', Number(st1.a.nextInitAt) > now && Number(st1.b.nextInitAt) > now);
  ok('首轮不写信', !DB.roleLetters);

  /* 2) 把 a/b 的 nextInitAt 置为过去 → 触发写信 */
  LS['ib_role_letters_state_v1'] = JSON.stringify({ a: { nextInitAt: now - 1000 }, b: { nextInitAt: now - 1000 } });
  await tick();
  const letters = Object.values(DB.roleLetters || {});
  const init = letters.filter(l => l.kind === 'init');
  ok('到期生成主动信', init.length >= 1, 'count=' + init.length);
  const first = init.find(l => String(l.fromRoleId) === 'a');
  ok('写信方向 a→b', !!first && String(first.toRoleId) === 'b');
  ok('信正文非空', !!first && String(first.content).length > 20);

  /* 3) 对偶冷却已写入 */
  const pairs = JSON.parse(LS['ib_role_letters_pair_v1'] || '{}');
  ok('对偶冷却已写入', typeof pairs['a|b'] === 'number' && pairs['a|b'] > 0);

  /* 4) 1天限流 + 冷却 → 再次 tick 不再写信 */
  const initCountBefore = (Object.values(DB.roleLetters || {}).filter(l => l.kind === 'init')).length;
  await tick();
  const initCountAfter = (Object.values(DB.roleLetters || {}).filter(l => l.kind === 'init')).length;
  ok('同日不再重复主动写', initCountAfter === initCountBefore, initCountBefore + '→' + initCountAfter);

  /* 5) 待回信队列（b 收到 a 的信） */
  const q = JSON.parse(LS['ib_role_letters_replyq_v1'] || '{}');
  ok('收信方进入待回信队列', !!q.b && q.b.letterId === first.id);
  ok('待回信延迟≥1h', q.b.dueAt - now >= 3600000);

  /* 6) 到期回信 → 写入回信 + 双方 Memory */
  LS['ib_role_letters_replyq_v1'] = JSON.stringify({ b: { letterId: first.id, dueAt: now - 1000 } });
  const memBefore = (Object.values(DB.memories || {}).filter(m => m.source === 'role_letter')).length;
  await tick();
  const after = Object.values(DB.roleLetters || {});
  const reply = after.find(l => l.kind === 'reply' && String(l.parentId) === first.id);
  ok('生成回信 b→a', !!reply && String(reply.fromRoleId) === 'b' && String(reply.toRoleId) === 'a');
  const updated = (DB.roleLetters || {})[first.id];
  ok('原信标记已回复', updated && updated.replyStatus === 'replied');
  const memAfter = (Object.values(DB.memories || {}).filter(m => m.source === 'role_letter')).length;
  ok('信件写入双方 Memory（≥2 条新增）', memAfter - memBefore >= 2, (memAfter - memBefore) + ' 条');
  ok('Memory 含收/发双方', (Object.values(DB.memories || {}).filter(m => m.source === 'role_letter' && String(m.characterId) === 'a')).length >= 1
    && (Object.values(DB.memories || {}).filter(m => m.source === 'role_letter' && String(m.characterId) === 'b')).length >= 1);
  ok('待回信队列已清空', !JSON.parse(LS['ib_role_letters_replyq_v1'] || '{}').b);

  /* 7) 回信后：b 不再主动写给 a（对偶冷却） */
  LS['ib_role_letters_state_v1'] = JSON.stringify({ a: { nextInitAt: now + 999999 }, b: { lastInitAt: 0, nextInitAt: now - 1000 } });
  await tick();
  const initOfBtoA = (Object.values(DB.roleLetters || {}).filter(l => l.kind === 'init' && String(l.fromRoleId) === 'b' && String(l.toRoleId) === 'a'));
  ok('冷却期 b 不主动写给 a', initOfBtoA.length === 0);

  const passCount = results.filter(r => r.pass).length;
  console.log('\n==== ' + passCount + '/' + results.length + ' PASS ====');
  process.exit(passCount === results.length ? 0 : 1);
})();
