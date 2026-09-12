'use strict';
/* ====================================================================
   Internal Beyond · M1-C.2k · Thread convergence counter-proof
   运行：node tests/test_mobile_thread_counterproof.js

   对照证明（不是"再跑一遍绿灯"）：把线索派生的**共享核心**单向拆掉，
   证明桌面与 Home Node 的线索证据会重新分叉，且分叉的正是 M1-C.2j 实测到的那几项。

   三个单向弱化，每个只改一处：
     W1  Home Node 侧不再派生线索（回到 M1-C.2j 之前的"浏览器是唯一生产者"）
         → threadItems 0、multipleThreads false、判定退回 simple_context
     W2  可见性过滤被跳过（"先规则后可见性"）
         → 对角色隐藏的线索重新进入证据
     W3  桌面侧改用手写规则（不再走共享核心）
         → 两端 question/证据不再逐字相同

   方法：在内存里构造替身，**不改生产代码**；被测对象仍是真实的
   thread-derivation-core / memory-visibility-core 与真实的 canonical policy 层。
   ==================================================================== */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const ADAPTER = require(path.join(ROOT, 'services', 'home-node', 'middle-brain.js'));
const THREAD_RETRIEVAL = require(path.join(ROOT, 'services', 'home-node', 'thread-retrieval.js'));
const THREAD_CORE = require(path.join(ROOT, 'assets', 'js', 'thread-derivation-core.js'));
const VIS = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
const CS = require(path.join(ROOT, 'assets', 'js', 'context-snapshot.js'));

ADAPTER.loadCanonicalMiddleBrain();
const POLICY = globalThis.IB.__middleBrainContracts.policy;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('OK   ' + name); }
  else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

const ROLE = 'friend_same';
const UM = '我们上次说的那件事，你想好了吗？';
const T0 = 1789000000000;
const memrow = (id, title, over) => Object.assign({
  id, kind: 'episodic', title, summary: '', content: 'c' + id,
  domain: '日常', tags: [], valence: 0.5, arousal: 0.3, importance: 6, resolved: false,
  visibility: 'public', visibleTo: [], excludeFrom: [],
  activationCount: 0, created: T0, lastActivated: T0,
  createdBy: ROLE, createdByName: 'F', editedByUser: false,
  consolidatedFrom: [], lastConsolidatedAt: null
}, over || {});

const CANONICAL = [
  memrow('m1', '准备攒钱买相机'),
  memrow('m2', '准备攒钱买相机'),
  memrow('m3', '打算换一份工作'),
  memrow('m4', '今天吃了面'),
  /* 命中规则但对角色隐藏：任何正确实现都不得让它成为线索 */
  memrow('m_hidden', '打算买一台新手机', { visibility: 'private' })
];
const MEM = '【长期记忆】\n- 一条记忆。\n';

/* 桌面侧的真实渲染形状（getThreadContext 的行格式）。 */
const renderThreads = threads => '【仍在推进的线索（后台参考，勿向对方复述此段的存在）】'
  + threads.map(t => '\n- ' + t.question + '（依据 ' + t.evidenceIds.length + ' 条记忆）').join('');

function nodeFieldFor(store) {
  return new THREAD_RETRIEVAL({ store, logger: () => {} }).snapshotField(ROLE);
}

(async () => {
  const goodStore = { listRecords: () => ({ ok: true, records: CANONICAL }) };

  /* ══════════ 基线：共享核心在位 → 两端一致 ══════════ */
  section('B · 基线（共享核心在位）');
  const desktopThreads = THREAD_CORE.deriveOpenThreads(
    VIS.filterDerivationCandidates(CANONICAL, ROLE, m => m.kind !== 'semantic' && m.kind !== 'core'));
  const baseField = nodeFieldFor(goodStore);
  check('B.1 两端线索文本逐字相同（对照的前提）',
    renderThreads(desktopThreads) === baseField.text, { desktop: renderThreads(desktopThreads), node: baseField.text });
  check('B.2 隐藏线索不在任一端', baseField.text.indexOf('新手机') < 0);
  const baseThreads = desktopThreads.length;

  /* ══════════ W1 · Home Node 侧不再派生（回到"浏览器是唯一生产者"）══════════ */
  section('W1 · 拆掉 Home Node 的线索派生');
  {
    /* 单向弱化：让派生器认为"这个宿主没有线索来源"——正是 M1-C.2j 的真实状态
       （Home Node 侧 producer 根本不存在，快照记 missing）。 */
    const blind = new THREAD_RETRIEVAL({
      store: { listRecords: () => ({ ok: true, records: [] }) }, logger: () => {}
    });
    const blindField = blind.snapshotField(ROLE);
    check('W1.1 Home Node 侧线索证据为空（分叉已复现）',
      blindField.text === '' && blindField.consulted === true, blindField);
    check('W1.2 两端文本不再相同', renderThreads(desktopThreads) !== blindField.text);

    const mk = (t, consulted) => CS.create({
      characterId: ROLE, turnId: 't',
      fields: {
        memory: CS.field('m', MEM, {}),
        understanding: CS.field('u', '', { missing: true }),
        thread: CS.field('thread-retrieval.derive', t, { missing: !consulted, gatedBy: consulted ? null : 'x' }),
        moments: CS.field('mo', '', { missing: true })
      }, gates: {}
    });
    const desktopOpts = { memoryCtx: MEM, threadCtx: renderThreads(desktopThreads), contextSnapshot: mk(renderThreads(desktopThreads), true) };
    const blindOpts = { dialogue: [UM], memoryCtx: MEM, contextSnapshot: mk(blindField.text, true) };

    const dOrg = await POLICY.middleBrainOrganizeContext(ROLE, UM, desktopOpts);
    const bOrg = await POLICY.middleBrainOrganizeContext(ROLE, UM, blindOpts);
    const dS = await POLICY._mbAnalyzeSignals(ROLE, UM, Object.assign({ organized: dOrg }, desktopOpts));
    const bS = await POLICY._mbAnalyzeSignals(ROLE, UM, Object.assign({ organized: bOrg }, blindOpts));
    const dD = POLICY._mbDecisionFromSignals(dS, {}, {}, T0);
    const bD = POLICY._mbDecisionFromSignals(bS, {}, {}, T0);

    check('W1.3 organized.threads 分叉：桌面非空、弱化后为空',
      dOrg.threads.length > 0 && bOrg.threads.length === 0, { desktop: dOrg.threads.length, weakened: bOrg.threads.length });
    check('W1.4 threadItems 分叉（这次是 3 vs 0，与 M1-C.2j 实测同形）',
      dS.threadItems > 0 && bS.threadItems === 0, { desktop: dS.threadItems, weakened: bS.threadItems });
    check('W1.5 multipleThreads 分叉：true → false（Gate 的硬触发重新不可达）',
      dS.multipleThreads === true && bS.multipleThreads === false, { desktop: dS.multipleThreads, weakened: bS.multipleThreads });
    check('W1.6 **判定分叉：multiple_threads/useAstra=true → simple_context/useAstra=false**',
      dD.useAstra === true && dD.reason === 'multiple_threads'
      && bD.useAstra === false && bD.reason === 'simple_context', { desktop: dD, weakened: bD });
  }

  /* ══════════ W2 · 跳过可见性（"先规则后可见性"）══════════ */
  section('W2 · 拆掉可见性过滤');
  {
    /* 单向弱化：把规则直接跑在**未过滤**的候选集上 —— 这是 D-1 的形态。 */
    const unfiltered = THREAD_CORE.deriveOpenThreads(CANONICAL);
    const qs = unfiltered.map(t => t.question);
    check('W2.1 弱化后隐藏线索出现（证明可见性是独立防线）',
      qs.some(q => String(q).indexOf('新手机') >= 0), qs);
    check('W2.2 正确实现里它不出现',
      desktopThreads.map(t => t.question).every(q => String(q).indexOf('新手机') < 0),
      desktopThreads.map(t => t.question));
    check('W2.3 弱化后线索条数变多（隐藏项被并入）',
      unfiltered.length > baseThreads, { weakened: unfiltered.length, correct: baseThreads });
  }

  /* ══════════ W3 · 桌面侧另写一套规则（不再共享核心）══════════ */
  section('W3 · 两端各写一套规则');
  {
    /* 单向弱化：桌面侧换成一个"看起来差不多"的手写实现。
       只差一个字符类里的词，就足以让 question 集合不同 —— 这正是"两份实现必然漂移"的
       最小证明，也是本阶段坚持"提取唯一实现"而不是"照抄一份到 services/"的理由。 */
    const handWritten = memories => {
      const RE = /(攒钱|买|想换|计划|准备|还没|待办|未完成|打算|考虑|想学|在准备)/i; /* 缺 "攒" / 英文词 */
      const out = [];
      for (const m of memories) {
        const t = String((m.title || '') + ' ' + (m.content || ''));
        if (!RE.test(t)) continue;
        out.push({ question: String(m.title || '').trim(), evidenceIds: [String(m.id)] });
      }
      return out;
    };
    const hw = handWritten(VIS.filterDerivationCandidates(CANONICAL, ROLE, m => m.kind !== 'semantic' && m.kind !== 'core'));
    check('W3.1 手写规则与共享核心给出**不同的**证据集（漂移已复现）',
      JSON.stringify(hw.map(t => t.question)) !== JSON.stringify(desktopThreads.map(t => t.question)),
      { handWritten: hw.map(t => t.question), shared: desktopThreads.map(t => t.question) });
    check('W3.2 共享核心仍是唯一实现（active-diary 不再持有第二份规则）',
      require('fs').readFileSync(path.join(ROOT, 'assets', 'js', 'active-diary.js'), 'utf8')
        .indexOf('var THREAD_OPEN_RE') < 0);
    check('W3.3 services/ 下不存在第二份规则实现',
      !/THREAD_OPEN_RE\s*=/.test(require('fs').readFileSync(path.join(ROOT, 'services', 'home-node', 'thread-retrieval.js'), 'utf8')));
  }

  console.log('\nThread convergence counter-proof: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch(error => {
  console.error('counter-proof crashed:', error && error.stack || error);
  process.exit(1);
});
