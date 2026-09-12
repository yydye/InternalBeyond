'use strict';
/* Internal Beyond · M1-C.2d Wave 1 · Memory Contract Closure（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_contract_closure.js

   目的：证明"从某角色隐藏的记忆"无法经**任何派生制品**回流进该角色的模型输入，
   且编辑/派生不会静默削弱 provenance 或可见性。

   方法：抽取**真实生产源码片段**（fragment），在 vm 中以合成 IndexedDB 执行，
   绝不复制一套实现来测另一套实现。边界字符串使用函数名而非行号。

   覆盖：
     T1  隐藏记忆不能进入 Understanding 派生请求（可见记忆可以）
     T2  隐藏记忆不能开 Thread
     T3  证据可见性收紧后，派生制品不再对该角色有效（stale）
     T4  证据查询失败 → fail closed（制品不被静默接受为有效）
     T5  编辑 consolidated 记忆保留 provenance（kind/consolidatedFrom/lastConsolidatedAt）
     T6  隐藏高分记忆不影响可见选择 / top-k（SAFE_PRE_FILTER 回归）
     T7  检索=纯选择 + 事后强化（激活失败不摧毁已选上下文）
     T8  共享可见性核心的纯函数语义（唯一实现，fail closed） */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js');
const CORE = require(CORE_PATH);
/* M1-C.2d Wave 2：召回（打分/排序/top-k/渲染）也收敛成唯一实现。
   memory.js 只做委托，因此本测试必须装载**真实**核心，而不是桩 —— 否则
   T6/T7 验证的就不再是生产选择逻辑。 */
const RETRIEVAL_PATH = path.join(ROOT, 'assets', 'js', 'memory-retrieval-core.js');
const RETRIEVAL_CORE = require(RETRIEVAL_PATH);

const source = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
function fragment(file, begin, end) {
  const text = source(file), start = text.indexOf(begin);
  assert.ok(start >= 0, 'source boundary missing: ' + begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start, 'source boundary missing: ' + end);
  return text.slice(start, stop);
}
const ACTIVE = 'assets/js/active-diary.js';
const MEMORY = 'assets/js/memory.js';

/* ── 真实源码片段（每个都以唯一函数/变量名为边界） ───────────────────────── */
/* active-diary.js：D-1 的规范边界 + 两个被测 producer */
const DERIVATION_HELPERS = fragment(ACTIVE, 'function _memDerivationCandidates(', '/* ══════════ Memory Provenance Repair');
const THREAD_TICK = fragment(ACTIVE, 'var THREAD_OPEN_RE=', '/* Understanding + Thread v1 调度');
/* _understandingTick 依赖 `_memNonSemantic` / `_memVisibleEvidenceIds`，
   二者都在 DERIVATION_HELPERS 内 —— 同源，不复制。 */
const UNDERSTANDING_TICK = fragment(ACTIVE, 'var _understandingWaterline=', '/* ---- Thread v1');
/* memory.js：D-2 的失效边界 + D-3 的编辑路径 + C3 的检索/强化拆分 */
const VISIBILITY_DELEGATE = fragment(MEMORY, 'function _ibMemVisCore(', '/* --- 语义相关性');
/* Understanding / Thread 的整个子系统（写时印章 R1、读时存证 R4、调和 R5/R7）。
   这一段的依赖闭包是：_ibMemVisCoreChecked / _ibEvidenceLiveness / _ibDeriveStamp /
   _normalizeVisStamp（都在 VISIBILITY_DELEGATE 里）+ dbGetAll/dbPut/dbGetByIndex。
   它是**一段连续的生产源码**，不是按需拼装 —— 分隔符越少，测试与生产漂移的面越小。 */
const ARTIFACTS = fragment(MEMORY, '/* ====================== UNDERSTANDING + THREAD v1', '/* 解析 AI 生成记忆时返回的');
const SAVE_MEMORY = fragment(MEMORY, 'async function saveMemory(', 'async function deleteMemory(');
const RETRIEVAL = fragment(MEMORY, '/* --- 衰减评分', '/* --- CRUD 操作 ---');
/* 纯选择 / 强化两段（C3）。两段是连续的，因此一个片段即可覆盖二者，
   也保证"选择不含副作用"这条断言是在真实的生产代码上验证的。 */
const SELECT_ONLY = fragment(MEMORY, 'async function selectMemoryContext(', 'function _formatMemLine(');

/* ── 合成环境：真实 store 语义（Map 副本），无 IndexedDB / DOM / 网络 ────── */
function makeEnv(opts) {
  opts = opts || {};
  const stores = new Map();
  const table = name => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  const writes = [];
  const env = {
    table, writes,
    dbGetAll: async name => [...table(name).values()].map(r => structuredClone(r)),
    dbGet: async (name, id) => { const r = table(name).get(id); return r ? structuredClone(r) : undefined },
    dbPut: async (name, row) => {
      if (opts.failPutFor && opts.failPutFor === name) throw new Error('simulated IndexedDB write failure');
      writes.push(name);
      table(name).set(row.id, structuredClone(row));
    }
  };
  return env;
}

/* 装载片段的环境：window 自指 + 真实共享核心。 */
function makeContext(env, extra) {
  const context = Object.assign({
    console, setTimeout, clearTimeout, Date, Map, Set, Math, JSON, Promise, structuredClone,
    dbGetAll: env.dbGetAll, dbGet: env.dbGet, dbPut: env.dbPut,
    IBMemoryVisibilityCore: CORE,
    IBMemoryRetrievalCore: RETRIEVAL_CORE,
    getMemorySettings: env.getMemorySettings || (async () => ({ budget: 2000, contentLen: 200 }))
  }, extra || {});
  context.window = context;
  vm.createContext(context);
  return context;
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

/* 记忆行工厂：默认 public + 由该角色写入（可见）。 */
function mem(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: '标题' + id, summary: '', content: '内容' + id,
    domain: '日常', tags: [], valence: 0.5, arousal: 0.4, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: 1000, lastActivated: 1000,
    createdBy: 'role-a', createdByName: 'A', consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}
const CFG = { id: 'role-a', nickname: 'A', systemPrompt: '你是 A。', provider: 'custom', model: 'm', endpoint: 'http://127.0.0.1:1' };

(async () => {

  /* ══════════════ T1 · 隐藏记忆不能进入 Understanding 派生请求 ══════════════ */
  section('T1 · Understanding producer 不含隐藏记忆');
  {
    const env = makeEnv();
    /* 可见记忆 A；隐藏记忆 X —— createdBy 也是本角色（这正是旧判据放行的那一类） */
    env.table('memories').set('mem_A', mem('mem_A', { content: 'VISIBLE_A_MARKER', importance: 3, created: 1000 }));
    env.table('memories').set('mem_X', mem('mem_X', {
      content: 'HIDDEN_X_MARKER', importance: 10, created: 9999,
      visibility: 'only', visibleTo: ['role-b'] /* 明确不含 role-a */
    }));
    let sent = '';
    const ctx = makeContext(env);
    vm.runInContext(DERIVATION_HELPERS + UNDERSTANDING_TICK, ctx);
    ctx.callApiChat = async (cfg, messages) => { sent = JSON.stringify(messages); return '{"shouldUpdate":false}'; };
    ctx._activeParsePlanJson = JSON.parse;
    ctx._calibrateMemoryCandidate = async () => ({ rejected: true }); /* 只关心"送到模型的是什么" */
    ctx._ibApiReady = () => true;
    ctx.unGetActive = async () => null;
    ctx.unWrite = async () => ({ id: 'un_1' });
    ctx.apiConfigs = [CFG];
    await ctx._understandingTick(CFG);

    check('T1.1 派生请求确实发生（否则断言无意义）', sent.length > 0);
    check('T1.2 可见记忆进入派生请求', sent.includes('VISIBLE_A_MARKER'), sent.slice(0, 400));
    check('T1.3 隐藏记忆的文本**没有**进入派生请求', !sent.includes('HIDDEN_X_MARKER'), sent.slice(0, 400));

    /* 反向对照：把 X 改成可见后，它必须出现 —— 证明 T1.3 不是"恒不出现"的假绿 */
    env.table('memories').set('mem_X', mem('mem_X', { content: 'HIDDEN_X_MARKER', importance: 10, created: 9999 }));
    const ctx2 = makeContext(env);
    vm.runInContext(DERIVATION_HELPERS + UNDERSTANDING_TICK, ctx2);
    let sent2 = '';
    ctx2.callApiChat = async (cfg, messages) => { sent2 = JSON.stringify(messages); return '{"shouldUpdate":false}' };
    ctx2._activeParsePlanJson = JSON.parse;
    ctx2._calibrateMemoryCandidate = async () => ({ rejected: true });
    ctx2._ibApiReady = () => true;
    ctx2.unGetActive = async () => null;
    ctx2.unWrite = async () => ({ id: 'un_1' });
    ctx2.apiConfigs = [CFG];
    await ctx2._understandingTick(CFG);
    check('T1.4 对照：同一条记忆变可见后确实进入请求', sent2.includes('HIDDEN_X_MARKER'), sent2.slice(0, 400));

    /* evidenceIds 准入：模型谎报一条隐藏记忆为证据 → 必须被丢弃 */
    env.table('memories').set('mem_X', mem('mem_X', { content: 'HIDDEN_X_MARKER', visibility: 'only', visibleTo: ['role-b'] }));
    const ctx3 = makeContext(env);
    vm.runInContext(DERIVATION_HELPERS + UNDERSTANDING_TICK, ctx3);
    let written = null;
    ctx3.callApiChat = async () => JSON.stringify({
      shouldUpdate: true, content: '一条理解', basis: 'ai_inference', dimension: 'context',
      conviction: 70, evidenceIds: ['mem_A', 'mem_X']
    });
    ctx3._activeParsePlanJson = JSON.parse;
    ctx3._calibrateMemoryCandidate = async () => ({ rejected: false, confidence: 70 });
    ctx3._ibApiReady = () => true;
    ctx3.unGetActive = async () => null;
    ctx3.unWrite = async (roleId, next) => { written = next; return { id: 'un_1' } };
    ctx3.apiConfigs = [CFG];
    await ctx3._understandingTick(CFG);
    check('T1.5 evidenceIds 只保留可见证据（mem_A）', !!written && JSON.stringify(written.evidenceIds) === '["mem_A"]', written && written.evidenceIds);
  }

  /* ══════════════ T2 · 隐藏记忆不能开 Thread ══════════════ */
  section('T2 · Thread producer 不含隐藏记忆');
  {
    const env = makeEnv();
    /* 两条都命中"未完成事项"规则；X 对 role-a 隐藏 */
    env.table('memories').set('mem_V', mem('mem_V', { title: '计划买相机', content: '打算攒钱买相机' }));
    env.table('memories').set('mem_X', mem('mem_X', {
      title: '准备换手机', content: '打算攒钱换手机', visibility: 'private'
    }));
    const opened = [];
    const ctx = makeContext(env);
    vm.runInContext(DERIVATION_HELPERS + THREAD_TICK, ctx);
    ctx.thOpen = async (roleId, question, evidenceId, createdBy) => { opened.push(question); return { id: 'th_' + opened.length } };
    const created = await ctx._threadRuleTick(CFG);
    check('T2.1 只为可见记忆开 Thread', created === 1 && opened.length === 1, { created, opened });
    check('T2.2 开出的 Thread 来自可见记忆', opened[0] === '计划买相机', opened);
    check('T2.3 隐藏记忆的问题串没有出现', !opened.some(q => String(q).includes('换手机')), opened);
  }

  /* ══════════════ T3 · 证据可见性收紧 → 制品不再有效 ══════════════ */
  section('T3 · 证据收紧后制品失效');
  {
    const env = makeEnv();
    env.table('memories').set('e1', mem('e1', { content: 'EVIDENCE_ONE' }));
    env.table('memories').set('e2', mem('e2', { content: 'EVIDENCE_TWO' }));
    env.table('understandings').set('un_1', {
      id: 'un_1', kind: 'understanding', characterId: 'role-a', status: 'active', dimension: 'relationship',
      createdAt: 1, lastUpdatedAt: 1,
      current: { content: '这段关系稳定', conviction: 70, basis: 'ai_inference', evidenceIds: ['e1', 'e2'], updatedAt: 1, updatedBy: 'A' },
      history: []
    });
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx);

    /* 前置：证据都可见时制品保持 active（证明 T3 不是因为"永远 stale"而假绿） */
    await ctx._reconcileReferences('e1');
    check('T3.1 证据可见时制品仍 active', env.table('understandings').get('un_1').status === 'active');

    /* 收紧：把 e2 对 role-a 隐藏（仅存在性不变 —— 这正是旧实现漏掉的形态） */
    env.table('memories').set('e2', mem('e2', { content: 'EVIDENCE_TWO', visibility: 'only', visibleTo: ['role-b'] }));
    await ctx._reconcileReferences('e2');
    const u = env.table('understandings').get('un_1');
    check('T3.2 证据失可见 → status 不再是 active', u.status !== 'active', u.status);
    check('T3.3 R7：原因区分"被隐藏"（evidence-hidden）而非"真丢失"', u.closedReason === 'evidence-hidden', u.closedReason);
    check('T3.4 证据行仍然存在（不是被删导致的假绿）', !!env.table('memories').get('e2'));

    /* Thread 同一边界 */
    env.table('threads').set('th_1', {
      id: 'th_1', kind: 'thread', characterId: 'role-a', status: 'open', question: '攒钱买相机',
      evidenceIds: ['e1', 'e2'], mentionCount: 1, createdAt: 1, lastUpdatedAt: 1
    });
    await ctx._reconcileReferences('e2');
    const t = env.table('threads').get('th_1');
    check('T3.5 Thread 同一边界：不再 open', t.status !== 'open', t.status);
    check('T3.6 Thread 标记为 orphan', t.status === 'orphan', t.status);
    check('T3.7 Thread 的失效原因同样是 evidence-hidden（R7）', t.closedReason === 'evidence-hidden', t.closedReason);
  }

  /* ══════════════ T4 · 证据查询失败 → fail closed ══════════════ */
  section('T4 · 证据不可查时 fail closed');
  {
    const env = makeEnv();
    env.table('memories').set('e1', mem('e1'));
    env.table('understandings').set('un_f', {
      id: 'un_f', kind: 'understanding', characterId: 'role-a', status: 'active', dimension: 'context',
      createdAt: 1, lastUpdatedAt: 1,
      current: { content: '依赖 e1 的理解', conviction: 60, basis: 'ai_inference', evidenceIds: ['e1'], updatedAt: 1, updatedBy: 'A' },
      history: []
    });
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx);
    /* 注入查询故障：旧实现 `catch(e){return ids}` 会把 ids 当存活 → 制品静默保持有效 */
    ctx.dbGetAll = async name => { if (name === 'memories') throw new Error('IndexedDB unavailable'); return [...env.table(name).values()] };
    await ctx._reconcileReferences('e1');
    const u = env.table('understandings').get('un_f');
    check('T4.1 查询故障 → 制品不被静默接受为有效', u.status !== 'active', u.status);
    check('T4.2 故障路径同样标记 evidence-lost', u.closedReason === 'evidence-lost', u.closedReason);

    /* 证据缺失（不是故障，是行真的没了） */
    const env2 = makeEnv();
    env2.table('understandings').set('un_g', {
      id: 'un_g', kind: 'understanding', characterId: 'role-a', status: 'active', dimension: 'context',
      createdAt: 1, lastUpdatedAt: 1,
      current: { content: '依赖 ghost 的理解', conviction: 60, basis: 'ai_inference', evidenceIds: ['ghost'], updatedAt: 1, updatedBy: 'A' },
      history: []
    });
    const ctx2 = makeContext(env2);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx2);
    await ctx2._reconcileReferences('ghost');
    check('T4.3 证据行缺失 → 制品失效', env2.table('understandings').get('un_g').status !== 'active');

    /* 未提供 roleId 的既有调用方语义不变（只判存在性） */
    const aliveNoRole = await ctx2.unEvidenceAlive(['ghost']);
    check('T4.4 无 roleId 时仍是"存在性"语义（向后兼容）', aliveNoRole.length === 0);
    const env3 = makeEnv();
    env3.table('memories').set('m1', mem('m1'));
    env3.table('memories').set('m_restricted', mem('m_restricted', { visibility: 'only', visibleTo: ['role-a'] }));
    const ctx3 = makeContext(env3);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx3);
    check('T4.5 无 roleId 且行存在 → 视为存活', (await ctx3.unEvidenceAlive(['m1'])).length === 1);
    check('T4.6 有 roleId 且行对该角色不可见 → 不算存活',
      (await ctx3.unEvidenceAlive(['m_restricted'], 'role-b')).length === 0);
    check('T4.7 有 roleId 且行对该角色可见 → 仍算存活',
      (await ctx3.unEvidenceAlive(['m_restricted'], 'role-a')).length === 1);
  }

  /* ══════════════ T5 · 编辑 consolidated 记忆保留 provenance ══════════════ */
  section('T5 · 编辑保留固化 provenance');
  {
    const env = makeEnv();
    env.table('memories').set('sem_1', {
      id: 'sem_1', kind: 'semantic', source: 'consolidation', sourceId: 'role-a',
      title: '旧标题', summary: '旧概括', content: '语义正文', oneLine: '', rawSource: undefined,
      domain: '日常', tags: ['consolidated'], valence: 0.5, arousal: 0.4, importance: 7,
      resolved: false, pinned: false, visibility: 'only', visibleTo: ['role-a'], excludeFrom: [],
      activationCount: 4, created: 111, lastActivated: 222,
      createdBy: 'role-a', createdByName: 'A', editedByUser: false,
      consolidatedFrom: ['epi_1', 'epi_2'], lastConsolidatedAt: 1700000000000
    });
    /* 表单替身：只改标题/内容/可见性，其余字段不在 UI 里（这正是 D-3 的成因） */
    const form = {
      'mem-f-title': '新标题', 'mem-f-summary': '旧概括', 'mem-f-content': '语义正文（用户修订）',
      'mem-f-oneline': '', 'mem-f-source': 'manual', 'mem-f-domain': '日常', 'mem-f-tags': 'consolidated',
      'mem-f-valence': '0.5', 'mem-f-arousal': '0.4', 'mem-f-importance': '7',
      'mem-f-resolved': 'false', 'mem-f-pinned': 'false',
      'mem-f-visibility': 'only'
    };
    const ctx = makeContext(env, {
      document: {
        getElementById: id => (Object.prototype.hasOwnProperty.call(form, id) ? { value: form[id] } : null),
        querySelectorAll: sel => (sel === '#mem-api-checks input:checked' ? [{ value: 'role-a' }] : [])
      },
      _editingMemId: 'sem_1',
      closeMemoryModal() {}, renderMemories() {}, updateMemDashboard() {}, toast() {}
    });
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS + SAVE_MEMORY, ctx);
    await ctx.saveMemory();
    const after = env.table('memories').get('sem_1');
    check('T5.1 kind 保持 semantic', after.kind === 'semantic', after.kind);
    check('T5.2 consolidatedFrom 保留', JSON.stringify(after.consolidatedFrom) === '["epi_1","epi_2"]', after.consolidatedFrom);
    check('T5.3 lastConsolidatedAt 保留', after.lastConsolidatedAt === 1700000000000, after.lastConsolidatedAt);
    check('T5.4 source 保持 consolidation（不回落到 manual）', after.source === 'consolidation', after.source);
    check('T5.5 sourceId 保留', after.sourceId === 'role-a', after.sourceId);
    check('T5.6 表单改动确实生效（标题/正文被更新）', after.title === '新标题' && after.content === '语义正文（用户修订）', { t: after.title });
    check('T5.7 可见性仍由表单决定（未被静默改写）', after.visibility === 'only' && JSON.stringify(after.visibleTo) === '["role-a"]', { v: after.visibility, to: after.visibleTo });
    check('T5.8 activationCount 与 created 保持既有行为', after.activationCount === 4 && after.created === 111, { a: after.activationCount, c: after.created });

    /* 用户明确改可见性 → 引用该记忆的制品必须被重新校验 */
    form['mem-f-visibility'] = 'only';
    const env2 = makeEnv();
    env2.table('memories').set('sem_2', {
      id: 'sem_2', kind: 'episodic', title: 'T', summary: '', content: 'C', domain: '日常', tags: [],
      valence: 0.5, arousal: 0.4, importance: 5, resolved: false, pinned: false,
      visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 0, created: 1, lastActivated: 1,
      createdBy: 'role-a', createdByName: 'A', editedByUser: false
    });
    env2.table('understandings').set('un_e', {
      id: 'un_e', kind: 'understanding', characterId: 'role-a', status: 'active', dimension: 'context',
      createdAt: 1, lastUpdatedAt: 1,
      current: { content: '引用 sem_2', conviction: 50, basis: 'ai_inference', evidenceIds: ['sem_2'], updatedAt: 1, updatedBy: 'A' },
      history: []
    });
    const form2 = Object.assign({}, form, { 'mem-f-title': 'T', 'mem-f-content': 'C', 'mem-f-visibility': 'only' });
    const ctx2 = makeContext(env2, {
      document: {
        getElementById: id => (Object.prototype.hasOwnProperty.call(form2, id) ? { value: form2[id] } : null),
        querySelectorAll: sel => (sel === '#mem-api-checks input:checked' ? [] : [])
      },
      _editingMemId: 'sem_2',
      closeMemoryModal() {}, renderMemories() {}, updateMemDashboard() {}, toast() {}
    });
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS + SAVE_MEMORY, ctx2);
    await ctx2.saveMemory();
    const ue = env2.table('understandings').get('un_e');
    check('T5.9 编辑把证据改成 only 且不再含该角色 → 引用它的理解失效', ue.status !== 'active', ue.status);
  }

  /* ══════════════ T6 · SAFE_PRE_FILTER 回归 ══════════════ */
  section('T6 · 可见性先于 ranking');
  {
    const env = makeEnv();
    /* 隐藏记忆被刻意设成"最高分"（高重要性 + 高激活 + 置顶），可见记忆是低分 */
    env.table('memories').set('hot_hidden', mem('hot_hidden', {
      title: 'HIDDEN_HIGH_SCORE', content: 'HIDDEN_HIGH_SCORE_BODY',
      importance: 10, pinned: true, activationCount: 900, visibility: 'private'
    }));
    env.table('memories').set('cold_visible', mem('cold_visible', {
      title: 'VISIBLE_LOW_SCORE', content: 'VISIBLE_LOW_SCORE_BODY', importance: 2, created: 1000
    }));
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + RETRIEVAL + SELECT_ONLY, ctx);
    const picked = await ctx.selectMemoryContext('role-a', { maxChars: 800, userMessage: '' });
    check('T6.1 隐藏高分记忆不出现在上下文', !picked.context.includes('HIDDEN_HIGH_SCORE'), picked.context);
    check('T6.2 隐藏高分记忆不在 selectedIds', picked.selectedIds.indexOf('hot_hidden') < 0, picked.selectedIds);
    check('T6.3 可见低分记忆仍然入选', picked.context.includes('VISIBLE_LOW_SCORE'), picked.context);
    check('T6.4 纯选择阶段零写入', env.writes.length === 0, env.writes);

    /* 对照：同一条记忆变为可见时，它必须凭高分入选 —— 证明 T6.1 不是"永远不选" */
    env.table('memories').set('hot_hidden', mem('hot_hidden', {
      title: 'HIDDEN_HIGH_SCORE', content: 'HIDDEN_HIGH_SCORE_BODY',
      importance: 10, pinned: true, activationCount: 900
    }));
    const ctx2 = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + RETRIEVAL + SELECT_ONLY, ctx2);
    const picked2 = await ctx2.selectMemoryContext('role-a', { maxChars: 800, userMessage: '' });
    check('T6.5 对照：变可见后高分记忆入选', picked2.context.includes('HIDDEN_HIGH_SCORE'), picked2.context);
  }

  /* ══════════════ T7 · 选择 / 强化拆分 ══════════════ */
  section('T7 · 激活拆分');
  {
    const env = makeEnv();
    env.table('memories').set('m1', mem('m1', { activationCount: 2, lastActivated: 1 }));
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + RETRIEVAL + SELECT_ONLY, ctx);

    const before = JSON.stringify(env.table('memories').get('m1'));
    const picked = await ctx.selectMemoryContext('role-a', { maxChars: 800, userMessage: '' });
    check('T7.1 选择返回 selectedIds', picked.selectedIds.length === 1 && picked.selectedIds[0] === 'm1', picked.selectedIds);
    check('T7.2 选择阶段不写库（强化前 activationCount 不变）',
      JSON.stringify(env.table('memories').get('m1')) === before, env.table('memories').get('m1'));

    const n = await ctx.recordMemoryActivation(picked.selectedIds);
    check('T7.3 强化阶段确实更新激活字段',
      n === 1 && env.table('memories').get('m1').activationCount === 3 && env.table('memories').get('m1').lastActivated > 1,
      env.table('memories').get('m1'));

    /* 选择结果与强化解耦：强化不改动"本轮已选出的结果" */
    const pickedAgain = await ctx.selectMemoryContext('role-a', { maxChars: 800, userMessage: '' });
    check('T7.4 强化后重新选择仍稳定选中同一条', JSON.stringify(pickedAgain.selectedIds) === JSON.stringify(picked.selectedIds), pickedAgain.selectedIds);

    /* 强化失败不摧毁已成功的上下文 */
    const envF = makeEnv();
    envF.table('memories').set('m1', mem('m1', { activationCount: 5 }));
    const ctxF = makeContext(envF);
    vm.runInContext(VISIBILITY_DELEGATE + RETRIEVAL + SELECT_ONLY, ctxF);
    ctxF.dbPut = async () => { throw new Error('simulated write failure'); };
    const full = await ctxF.getMemoryContext('role-a', { maxChars: 800, userMessage: '' });
    check('T7.5 激活写入失败时 getMemoryContext 仍返回成功的上下文', full.includes('VISIBLE') || full.includes('内容m1') || full.length > 0, full);
    check('T7.6 失败未抛出（调用方无感）', typeof full === 'string');

    check('T7.7 recordMemoryActivation 对空选择是 no-op', (await ctx.recordMemoryActivation([])) === 0);
  }

  /* ══════════════ T8 · 共享核心的纯函数语义 ══════════════ */
  section('T8 · 共享可见性核心');
  {
    check('T8.1 private 对任何人不可见',
      CORE.isMemoryVisibleTo({ visibility: 'private', createdBy: 'role-a' }, 'role-a', false, false) === false);
    check('T8.2 缺失 visibility → 不可见（fail closed）',
      CORE.isMemoryVisibleTo({ content: 'x' }, 'role-a', false, false) === false);
    check('T8.3 only 命中 visibleTo → 可见',
      CORE.isMemoryVisibleTo({ visibility: 'only', visibleTo: ['role-a'] }, 'role-a', false, false) === true);
    check('T8.4 only 未命中 → 不可见',
      CORE.isMemoryVisibleTo({ visibility: 'only', visibleTo: ['role-b'] }, 'role-a', false, false) === false);
    check('T8.5 except 排除 → 不可见',
      CORE.isMemoryVisibleTo({ visibility: 'except', excludeFrom: ['role-a'] }, 'role-a', false, false) === false);
    check('T8.6 群聊未开启群记忆 → 不可见',
      CORE.isMemoryVisibleTo({ visibility: 'public' }, 'role-a', true, false) === false);
    check('T8.7 群聊开启后仅 public 可见',
      CORE.isMemoryVisibleTo({ visibility: 'public' }, 'role-a', true, true) === true
      && CORE.isMemoryVisibleTo({ visibility: 'only', visibleTo: ['role-a'] }, 'role-a', true, true) === false);

    /* 派生合并：只收窄，绝不放宽 */
    check('T8.8 全 public → public', CORE.deriveVisibility([{ visibility: 'public' }], 'role-a').visibility === 'public');
    check('T8.9 任一 private → private',
      CORE.deriveVisibility([{ visibility: 'public' }, { visibility: 'private' }], 'role-a').visibility === 'private');
    check('T8.10 缺失 visibility 按 only 级保守（不放宽为 public）',
      CORE.deriveVisibility([{ visibility: 'public' }, {}], 'role-a').visibility === 'only');
    check('T8.11 空来源集 → private（fail closed）',
      CORE.deriveVisibility([], 'role-a').visibility === 'private');
    check('T8.12 only 交集且保证角色自己能召回',
      JSON.stringify(CORE.deriveVisibility([{ visibility: 'only', visibleTo: ['role-x'] }], 'role-a').visibleTo) === '["role-x","role-a"]');
    check('T8.13 except 取并集（不放开任何排除）',
      JSON.stringify(CORE.deriveVisibility([{ visibility: 'except', excludeFrom: ['r1'] }, { visibility: 'except', excludeFrom: ['r2'] }], 'role-a').excludeFrom) === '["r1","r2"]');

    /* 证据存活性 fail closed（roleId 缺省 = 只判存在性；给出 roleId = 追加可见性） */
    check('T8.14 缺证据行 → 不算存活',
      CORE.liveEvidenceIds(['a'], [{ id: 'b' }], null).length === 0);
    check('T8.15 内存集合不可用 → 不算存活（fail closed）',
      CORE.liveEvidenceIds(['a'], null, null).length === 0);
    check('T8.16 行存在但对给定角色不可见 → 不算存活',
      CORE.liveEvidenceIds(['a'], [{ id: 'a', visibility: 'private' }], 'role-a').length === 0);
    check('T8.17 存在且可见 → 存活',
      CORE.liveEvidenceIds(['a'], [{ id: 'a', visibility: 'public' }], 'role-a').length === 1);
    check('T8.17b 分类：missing / hidden / live 三分（R7 的判据来源）', (() => {
      const lv = CORE.evidenceLiveness(['live1', 'hid1', 'gone1'],
        [{ id: 'live1', visibility: 'public' }, { id: 'hid1', visibility: 'private' }], 'role-a');
      return JSON.stringify(lv.live) === '["live1"]' && JSON.stringify(lv.hidden) === '["hid1"]'
        && JSON.stringify(lv.missing) === '["gone1"]' && lv.reason === 'missing';
    })());
    check('T8.17c 重复 id 只计一次（否则调用方的 length 判据会被破坏）', (() => {
      const lv = CORE.evidenceLiveness(['a', 'a'], [{ id: 'a', visibility: 'public' }], 'role-a');
      return lv.live.length === 1;
    })());

    /* 唯一实现：memory.js / active-diary.js 不再持有第二份判断 */
    const memSrc = source(MEMORY), actSrc = source(ACTIVE);
    check('T8.18 memory.js 的 isMemoryVisibleTo 只做委托',
      /function isMemoryVisibleTo\([\s\S]{0,200}?core\.isMemoryVisibleTo\(/.test(memSrc));
    check('T8.19 active-diary.js 的 _memoryDeriveVisibility 只做委托',
      /function _memoryDeriveVisibility\([\s\S]{0,300}?core\.deriveVisibility\(/.test(actSrc));
    check('T8.20 不存在第二份 rank 表字面量', !/rank=4,onlySets/.test(actSrc) && !/rank=4,onlySets/.test(memSrc));
    check('T8.21 两个 producer 都走 _memDerivationCandidates',
      (actSrc.match(/_memDerivationCandidates\(/g) || []).length >= 3);

    /* 加载顺序：唯一实现的**前提条件**之一。core 若在消费方之后加载，
       memory.js 的委托会在首次召回时抛错（fail closed 但功能全失）。 */
    const html = source('InternalBeyond.html');
    const atCore = html.indexOf('assets/js/memory-visibility-core.js');
    const atMem = html.indexOf('assets/js/memory.js"');
    const atDiary = html.indexOf('assets/js/active-diary.js');
    check('T8.22 InternalBeyond.html 在 memory.js 之前加载共享核心',
      atCore >= 0 && atMem > atCore, { atCore, atMem });
    check('T8.23 InternalBeyond.html 在 active-diary.js 之前加载共享核心',
      atCore >= 0 && atDiary > atCore, { atCore, atDiary });
    check('T8.24 共享核心可被 Node require（UMD 双载）',
      typeof CORE.deriveVisibility === 'function' && typeof CORE.filterDerivationCandidates === 'function');

    /* 派生候选的 fail-closed：核心不可用时不得退化成"全部放行" */
    const ctxNoCore = makeContext(makeEnv());
    delete ctxNoCore.IBMemoryVisibilityCore;
    vm.runInContext(VISIBILITY_DELEGATE + DERIVATION_HELPERS, ctxNoCore);
    check('T8.25 核心缺失时 _memDerivationCandidates 返回空集（fail closed）',
      ctxNoCore._memDerivationCandidates([mem('x')], 'role-a', null).length === 0);
    check('T8.26 核心缺失时 _memVisibleEvidenceIds 返回空集（fail closed）',
      ctxNoCore._memVisibleEvidenceIds(['x'], [mem('x')], 'role-a').length === 0);
    check('T8.27 核心不可用时存证 fail closed（live 为空）', await (async () => {
      const lv = await ctxNoCore._ibEvidenceLiveness(['x'], 'role-a');
      return lv.live.length === 0 && lv.missing.length === 1 && lv.degraded === true;
    })());
  }

  /* ══════════════ T9 · R1 写时印章 ══════════════ */
  section('T9 · R1 写时印章');
  {
    const env = makeEnv();
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx);

    /* 印章 = 最严格证据范围 */
    check('T9.1 全 public 证据 → public 印章',
      ctx._ibDeriveStamp([{ visibility: 'public' }, { visibility: 'public' }], 'role-a').visibility === 'public');
    check('T9.2 任一 private → private 印章',
      ctx._ibDeriveStamp([{ visibility: 'public' }, { visibility: 'private' }], 'role-a').visibility === 'private');
    check('T9.3 核心缺失时的降级是 private（不放宽）', (() => {
      const c2 = makeContext(makeEnv());
      delete c2.IBMemoryVisibilityCore;
      vm.runInContext(VISIBILITY_DELEGATE, c2);
      return c2._ibDeriveStamp([{ visibility: 'public' }], 'role-a').visibility === 'private';
    })());

    /* 写路径：producer 给出印章 → 落盘 */
    const uNew = await ctx.unWrite('role-a', {
      content: '一段理解', conviction: 60, basis: 'ai_inference', dimension: 'context',
      evidenceIds: ['e1'], stamp: { visibility: 'only', visibleTo: ['role-a'] }
    });
    check('T9.4 unWrite 落盘印章', uNew && uNew.visibility && uNew.visibility.visibility === 'only', uNew && uNew.visibility);
    check('T9.5 印章名单保留', JSON.stringify(uNew.visibility.visibleTo) === '["role-a"]', uNew.visibility.visibleTo);

    /* producer 不给印章 → fail closed 到 private，绝不默认 public */
    const uNoStamp = await ctx.unWrite('role-b', {
      content: '另一段理解', conviction: 50, basis: 'ai_inference', dimension: 'context', evidenceIds: ['e1']
    });
    check('T9.6 未给印章 → private（fail closed，不默认 public）',
      uNoStamp.visibility.visibility === 'private', uNoStamp.visibility);

    /* 非法印章同样落到 private */
    const uBad = await ctx.unWrite('role-c', {
      content: '第三段理解', conviction: 50, basis: 'ai_inference', dimension: 'context',
      evidenceIds: ['e1'], stamp: { visibility: 'everyone' }
    });
    check('T9.7 词表外的印章值 → private（不引入第五档）',
      uBad.visibility.visibility === 'private', uBad.visibility);

    /* Thread：thOpen 采用 producer 印章；复用旧 Thread 时只能更窄 */
    const t1 = await ctx.thOpen('role-a', '攒钱买相机', ['e1'], 'ai', { visibility: 'only', visibleTo: ['role-a', 'role-b'] });
    check('T9.8 thOpen 落盘印章', t1.visibility.visibility === 'only' && t1.visibility.visibleTo.length === 2, t1.visibility);
    const t2 = await ctx.thOpen('role-a', '攒钱买相机', ['e2'], 'ai', { visibility: 'private' });
    check('T9.9 复用同一 Thread 时印章取更严（只可能更窄）', t2.visibility.visibility === 'private', t2.visibility);
    const t3 = await ctx.thOpen('role-d', '准备换手机', ['e1'], 'ai', null);
    check('T9.10 thOpen 无印章 → private（fail closed）', t3.visibility.visibility === 'private', t3.visibility);

    /* thMention：无新证据 → 印章不动；有新证据 → 收窄 */
    const env2 = makeEnv();
    env2.table('memories').set('m_a', mem('m_a', { visibility: 'public' }));
    env2.table('memories').set('m_b', mem('m_b', { visibility: 'private' }));
    env2.table('threads').set('th_x', {
      id: 'th_x', kind: 'thread', characterId: 'role-a', status: 'open', question: 'Q',
      evidenceIds: ['m_a'], mentionCount: 1, createdAt: 1, lastUpdatedAt: 1,
      visibility: { visibility: 'public', visibleTo: [], excludeFrom: [] }
    });
    const ctx2 = makeContext(env2);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx2);
    await ctx2.thMention('th_x', 'm_a'); /* 已存在 → 无新证据 */
    check('T9.11 mention 无新证据 → 印章不变',
      env2.table('threads').get('th_x').visibility.visibility === 'public', env2.table('threads').get('th_x').visibility);
    await ctx2.thMention('th_x', 'm_b'); /* 并入 private 证据 */
    check('T9.12 mention 并入更严证据 → 印章收窄',
      env2.table('threads').get('th_x').visibility.visibility === 'private', env2.table('threads').get('th_x').visibility);

    /* producer 侧：印章来源含旧版证据 → 不得放宽（R6） */
    const env3 = makeEnv();
    env3.table('memories').set('old_ev', mem('old_ev', { visibility: 'only', visibleTo: ['role-a'] }));
    env3.table('memories').set('new_ev', mem('new_ev', { visibility: 'public' }));
    const ctx3 = makeContext(env3);
    vm.runInContext(DERIVATION_HELPERS, ctx3);
    const stampNarrow = ctx3._memDerivationStamp([{ visibility: 'only', visibleTo: ['role-a'] }], 'role-a');
    const stampUnion = ctx3._memDerivationStamp([{ visibility: 'only', visibleTo: ['role-a'] }, { visibility: 'public' }], 'role-a');
    check('T9.13 旧版证据参与印章 → 不因新证据更宽而放宽',
      stampNarrow.visibility === 'only' && stampUnion.visibility === 'only',
      { stampNarrow: stampNarrow.visibility, stampUnion: stampUnion.visibility });
  }

  /* ══════════════ T10 · R4 读时存证 ══════════════ */
  section('T10 · R4 读时存证');
  {
    const mkUn = (id, ev, vis) => ({
      id: id, kind: 'understanding', characterId: 'role-a', status: 'active', dimension: 'relationship',
      createdAt: 1, lastUpdatedAt: 1, visibility: vis,
      current: { content: 'UNDERSTANDING_BODY', conviction: 70, basis: 'ai_inference', evidenceIds: ev, updatedAt: 1, updatedBy: 'A' },
      history: []
    });
    const STAMP_OK = { visibility: 'public', visibleTo: [], excludeFrom: [] };
    const STAMP_NO = { visibility: 'only', visibleTo: ['role-b'], excludeFrom: [] };

    /* (a) 印章与证据都成立 → 注入 */
    const env = makeEnv();
    env.table('memories').set('e1', mem('e1'));
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx);
    ctx.dbGetByIndex = async (store) => [...env.table(store).values()];
    env.table('understandings').set('un_ok', mkUn('un_ok', ['e1'], STAMP_OK));
    const okCtx = await ctx.getUnderstandingContext('role-a');
    check('T10.1 印章成立 + 证据可见 → 注入', okCtx.includes('UNDERSTANDING_BODY'), okCtx);

    /* (b) 印章不允许该角色 → 不注入（fail closed） */
    env.table('understandings').set('un_ok', mkUn('un_ok', ['e1'], STAMP_NO));
    check('T10.2 印章不允许该角色 → 不注入', (await ctx.getUnderstandingContext('role-a')) === '');

    /* (c) **关键**：印章仍然允许，但证据已在写盘后被隐藏 → 不注入。
        这正是"只信印章"会漏掉的形态：修复遍尚未运行时读取就不得泄漏。 */
    env.table('understandings').set('un_ok', mkUn('un_ok', ['e1'], STAMP_OK));
    env.table('memories').set('e1', mem('e1', { visibility: 'only', visibleTo: ['role-b'] }));
    check('T10.3 印章允许但证据已失可见 → 读时即拒（不等修复遍）',
      (await ctx.getUnderstandingContext('role-a')) === '');

    /* (d) 证据被删 → 不注入 */
    env.table('memories').delete('e1');
    check('T10.4 证据已缺失 → 不注入', (await ctx.getUnderstandingContext('role-a')) === '');

    /* (e) 无证据的制品 → 无从存证 → 不注入 */
    env.table('memories').set('e1', mem('e1'));
    env.table('understandings').set('un_ok', mkUn('un_ok', [], STAMP_OK));
    check('T10.5 无证据 → 不注入（无从存证）', (await ctx.getUnderstandingContext('role-a')) === '');

    /* (f) 未盖章的历史制品（旧数据）→ fail closed 不注入 */
    env.table('understandings').set('un_ok', mkUn('un_ok', ['e1'], undefined));
    check('T10.6 未盖章的历史制品 → 不注入（fail closed）', (await ctx.getUnderstandingContext('role-a')) === '');

    /* Thread：逐条存证，一条不合格不影响其他条 */
    const env2 = makeEnv();
    env2.table('memories').set('g1', mem('g1'));
    env2.table('memories').set('g2', mem('g2', { visibility: 'private' }));
    env2.table('threads').set('th_ok', {
      id: 'th_ok', kind: 'thread', characterId: 'role-a', status: 'open', question: '可见线索',
      evidenceIds: ['g1'], mentionCount: 2, createdAt: 1, lastUpdatedAt: 2, visibility: STAMP_OK
    });
    env2.table('threads').set('th_bad', {
      id: 'th_bad', kind: 'thread', characterId: 'role-a', status: 'open', question: '隐藏线索',
      evidenceIds: ['g2'], mentionCount: 2, createdAt: 1, lastUpdatedAt: 3, visibility: STAMP_OK
    });
    const ctx2 = makeContext(env2);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx2);
    ctx2.dbGetByIndex = async (store) => [...env2.table(store).values()];
    const thCtx = await ctx2.getThreadContext('role-a');
    check('T10.7 通过的线索被注入', thCtx.includes('可见线索'), thCtx);
    check('T10.8 证据不可见的线索被逐条剔除', !thCtx.includes('隐藏线索'), thCtx);
    env2.table('threads').delete('th_ok');
    check('T10.9 全部不合格 → 返回空（不返回空标题块）', (await ctx2.getThreadContext('role-a')) === '');
  }

  /* ══════════════ T11 · R5/R7 调和只收窄 ══════════════ */
  section('T11 · 调和 restamp 只收窄');
  {
    const env = makeEnv();
    env.table('memories').set('e_narrow', mem('e_narrow', { visibility: 'only', visibleTo: ['role-a'] }));
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx);
    const art = {
      id: 'un_s', characterId: 'role-a', visibility: { visibility: 'public', visibleTo: [], excludeFrom: [] },
      current: { evidenceIds: ['e_narrow'] }
    };
    await ctx._ibRestampDerived(art, 'understandings');
    check('T11.1 restamp 把过宽的印章收窄到证据范围',
      art.visibility.visibility === 'only', art.visibility);

    /* 反向：证据比印章更宽时，印章**不得**被放宽 */
    const env2 = makeEnv();
    env2.table('memories').set('e_wide', mem('e_wide', { visibility: 'public' }));
    const ctx2 = makeContext(env2);
    vm.runInContext(VISIBILITY_DELEGATE + ARTIFACTS, ctx2);
    const art2 = {
      id: 'un_s2', characterId: 'role-a', visibility: { visibility: 'only', visibleTo: ['role-a'], excludeFrom: [] },
      current: { evidenceIds: ['e_wide'] }
    };
    await ctx2._ibRestampDerived(art2, 'understandings');
    check('T11.2 restamp 绝不放宽已经更窄的印章',
      art2.visibility.visibility === 'only', art2.visibility);

    /* 印章缺失的历史制品不被 restamp 凭空造出一条边界 */
    const art3 = { id: 'un_s3', characterId: 'role-a', current: { evidenceIds: ['e_wide'] } };
    check('T11.3 未盖章制品不被 restamp（交给读时 fail closed）',
      (await ctx2._ibRestampDerived(art3, 'understandings')) === null && art3.visibility === undefined);
  }

  /* ══════════════ T12 · C3 时钟与随机注入 ══════════════ */
  section('T12 · 时钟 / 随机注入（可复现）');
  {
    const env = makeEnv();
    env.table('memories').set('r1', mem('r1', { content: 'REPRO_A', created: 1, lastActivated: 1, importance: 5 }));
    env.table('memories').set('r2', mem('r2', { content: 'REPRO_B', created: 1, lastActivated: 1, importance: 4 }));
    const ctx = makeContext(env);
    vm.runInContext(VISIBILITY_DELEGATE + RETRIEVAL + SELECT_ONLY, ctx);

    const at = () => 1 + 30 * 24 * 3600 * 1000; /* 固定"现在" */
    const a = await ctx.selectMemoryContext('role-a', { maxChars: 800, userMessage: '', now: at, random: () => 0 });
    const b = await ctx.selectMemoryContext('role-a', { maxChars: 800, userMessage: '', now: at, random: () => 0 });
    check('T12.1 相同 now/random → 相同上下文（可复现）', a.context === b.context && a.context.length > 0, a.context);
    check('T12.2 相同 now/random → 相同 selectedIds',
      JSON.stringify(a.selectedIds) === JSON.stringify(b.selectedIds), a.selectedIds);

    /* 时钟真的被使用：注入不同 now → 分数不同（衰减随注入时间变化） */
    const s1 = ctx.getMemoryScore(env.table('memories').get('r1'), at());
    const s2 = ctx.getMemoryScore(env.table('memories').get('r1'), at() + 365 * 24 * 3600 * 1000);
    check('T12.3 getMemoryScore 接受注入时钟且结果随时间变化', s1 > s2, { s1, s2 });

    /* 强化阶段接受注入时间戳 */
    const n = await ctx.recordMemoryActivation(['r1'], 1234567890);
    check('T12.4 recordMemoryActivation 接受注入时间戳',
      n === 1 && env.table('memories').get('r1').lastActivated === 1234567890,
      env.table('memories').get('r1').lastActivated);

    /* getMemoryContext 把 now 透传给强化阶段。
       注入的 now 必须 ≥ 记忆的 created/lastActivated —— 否则 daysSince 为负，
       会绕过"2 小时内反复激活"的疲劳窗口。用与记忆同一时刻的固定时间。 */
    const env2 = makeEnv();
    const T0 = 1_700_000_000_000;
    env2.table('memories').set('r9', mem('r9', { content: 'PASS_THROUGH', created: T0, lastActivated: T0 }));
    const ctx2 = makeContext(env2);
    vm.runInContext(VISIBILITY_DELEGATE + RETRIEVAL + SELECT_ONLY, ctx2);
    const out = await ctx2.getMemoryContext('role-a', { maxChars: 800, userMessage: '', now: () => T0 + 1000 });
    check('T12.5 getMemoryContext 仍返回上下文（强化不破坏它）', typeof out === 'string' && out.length > 0, out);
    check('T12.6 now 透传到强化写入', env2.table('memories').get('r9').lastActivated === T0 + 1000,
      env2.table('memories').get('r9').lastActivated);
  }

  console.log('\nMemory contract closure: ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
